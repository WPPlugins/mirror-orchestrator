/**
 * Zero-dependency GitHub App authentication & REST API client using crypto.subtle (RS256).
 */

export interface GitHubAppConfig {
  appId: string;
  privateKeyPem: string;
  targetOrg: string;
  dryRun?: boolean;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  homepage: string | null;
  default_branch: string;
  clone_url: string;
  topics?: string[];
}

export interface CreateRepoOptions {
  description?: string;
  homepage?: string;
  private?: boolean;
  autoInit?: boolean;
}

export interface UpdateRepoOptions {
  description?: string;
  homepage?: string;
}

const GITHUB_API_BASE = "https://api.github.com";
const MAX_RETRIES = 4;

/** Base64url-encode a byte array or UTF-8 string without padding. */
function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Encode an ASN.1 DER length field. */
function derLength(len: number): Uint8Array {
  if (len < 0x80) {
    return new Uint8Array([len]);
  }
  const bytes: number[] = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** Wrap a DER payload with an ASN.1 tag. */
function derWrap(tag: number, payload: Uint8Array): Uint8Array {
  const lenBytes = derLength(payload.length);
  const out = new Uint8Array(1 + lenBytes.length + payload.length);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(payload, 1 + lenBytes.length);
  return out;
}

/**
 * Wrap a PKCS#1 RSAPrivateKey DER buffer into a PKCS#8 PrivateKeyInfo DER buffer
 * so WebCrypto `crypto.subtle.importKey("pkcs8", ...)` can import GitHub App PEMs.
 */
function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const rsaOid = new Uint8Array([
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ]);
  const algId = derWrap(0x30, rsaOid);
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const privateKeyOctet = derWrap(0x04, pkcs1Der);

  const totalLen = version.length + algId.length + privateKeyOctet.length;
  const seqBody = new Uint8Array(totalLen);
  let offset = 0;
  seqBody.set(version, offset);
  offset += version.length;
  seqBody.set(algId, offset);
  offset += algId.length;
  seqBody.set(privateKeyOctet, offset);

  return derWrap(0x30, seqBody);
}

/** Decode a PEM-encoded RSA private key (PKCS#1 or PKCS#8) into a CryptoKey. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const base64Body = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  if (!base64Body) {
    throw new Error("APP_PRIVATE_KEY is empty or malformed.");
  }

  const binaryStr = atob(base64Body);
  const derBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    derBytes[i] = binaryStr.charCodeAt(i);
  }

  const pkcs8Bytes = isPkcs1 ? wrapPkcs1InPkcs8(derBytes) : derBytes;
  // Copy into a fresh ArrayBuffer to satisfy strict BufferSource typing in TS 6.
  const keyBuffer = new ArrayBuffer(pkcs8Bytes.byteLength);
  new Uint8Array(keyBuffer).set(pkcs8Bytes);

  return await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Sign a short-lived RS256 JWT for GitHub App authentication (valid 9 minutes). */
export async function createAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitHubAppClient {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  readonly targetOrg: string;
  readonly dryRun: boolean;

  private cachedToken: string | null = null;
  private tokenExpiresAtMs = 0;

  constructor(config: GitHubAppConfig) {
    this.appId = config.appId;
    this.privateKeyPem = config.privateKeyPem;
    this.targetOrg = config.targetOrg || "WPPlugins";
    this.dryRun = Boolean(config.dryRun);
  }

  static fromEnv(dryRun = false): GitHubAppClient | null {
    const appId = Deno.env.get("APP_ID")?.trim() ?? "";
    const privateKeyPem = Deno.env.get("APP_PRIVATE_KEY")?.trim() ?? "";
    const targetOrg = Deno.env.get("TARGET_ORG")?.trim() || "WPPlugins";

    if (!appId || !privateKeyPem) {
      return null;
    }

    return new GitHubAppClient({
      appId,
      privateKeyPem,
      targetOrg,
      dryRun,
    });
  }

  /** Mint or return a cached installation access token for `targetOrg`. */
  async getInstallationToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAtMs - 60_000) {
      return this.cachedToken;
    }

    const jwt = await createAppJwt(this.appId, this.privateKeyPem);
    const installation = await this.rawRequest<{ id: number }>(
      "GET",
      `/orgs/${encodeURIComponent(this.targetOrg)}/installation`,
      jwt,
    );

    const tokenResp = await this.rawRequest<{
      token: string;
      expires_at: string;
    }>(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      jwt,
    );

    this.cachedToken = tokenResp.token;
    this.tokenExpiresAtMs = Date.parse(tokenResp.expires_at);
    return tokenResp.token;
  }

  /** Perform an authenticated REST request with rate-limit awareness and exponential backoff. */
  private async rawRequest<T>(
    method: string,
    path: string,
    bearerToken: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${bearerToken}`,
        "User-Agent": "WPPlugins-Mirror-Orchestrator/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (allowNotFound && response.status === 404) {
        return null as T;
      }

      const remainingHeader = response.headers.get("X-RateLimit-Remaining");
      const resetHeader = response.headers.get("X-RateLimit-Reset");
      const retryAfterHeader = response.headers.get("Retry-After");

      if (
        response.status === 403 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        if (attempt === MAX_RETRIES) {
          const text = await response.text();
          throw new Error(
            `GitHub API ${method} ${path} failed (${response.status}): ${text}`,
          );
        }

        let waitMs = Math.min(60_000, 1000 * 2 ** attempt);
        if (retryAfterHeader) {
          const retrySec = Number(retryAfterHeader);
          if (!Number.isNaN(retrySec) && retrySec > 0) {
            waitMs = retrySec * 1000;
          }
        } else if (remainingHeader === "0" && resetHeader) {
          const resetMs = Number(resetHeader) * 1000 - Date.now();
          if (resetMs > 0) {
            waitMs = Math.min(resetMs + 1000, 120_000);
          }
        }

        console.warn(
          `[github-app] ${response.status} on ${method} ${path}; retrying in ${
            Math.round(waitMs / 1000)
          }s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `GitHub API ${method} ${path} failed (${response.status}): ${text}`,
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    throw new Error(`GitHub API ${method} ${path} exhausted retries.`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<T> {
    const token = await this.getInstallationToken();
    return await this.rawRequest<T>(method, path, token, body, allowNotFound);
  }

  async getRepo(repoName: string): Promise<GitHubRepo | null> {
    return await this.request<GitHubRepo | null>(
      "GET",
      `/repos/${encodeURIComponent(this.targetOrg)}/${
        encodeURIComponent(repoName)
      }`,
      undefined,
      true,
    );
  }

  async createOrgRepo(
    repoName: string,
    options: CreateRepoOptions = {},
  ): Promise<GitHubRepo> {
    if (this.dryRun) {
      throw new Error("createOrgRepo must not be called in dry-run mode.");
    }

    return await this.request<GitHubRepo>(
      "POST",
      `/orgs/${encodeURIComponent(this.targetOrg)}/repos`,
      {
        name: repoName,
        description: options.description ?? "",
        homepage: options.homepage ?? "",
        private: options.private ?? false,
        auto_init: options.autoInit ?? false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      },
    );
  }

  async updateRepoMetadata(
    repoName: string,
    options: UpdateRepoOptions,
  ): Promise<GitHubRepo> {
    if (this.dryRun) {
      throw new Error("updateRepoMetadata must not be called in dry-run mode.");
    }

    return await this.request<GitHubRepo>(
      "PATCH",
      `/repos/${encodeURIComponent(this.targetOrg)}/${
        encodeURIComponent(repoName)
      }`,
      {
        description: options.description,
        homepage: options.homepage,
      },
    );
  }

  async setRepoTopics(repoName: string, topics: string[]): Promise<void> {
    if (this.dryRun) {
      throw new Error("setRepoTopics must not be called in dry-run mode.");
    }

    await this.request<{ names: string[] }>(
      "PUT",
      `/repos/${encodeURIComponent(this.targetOrg)}/${
        encodeURIComponent(repoName)
      }/topics`,
      { names: topics },
    );
  }

  /**
   * Ensure the target repository exists and has up-to-date metadata and topics.
   * Returns `{ repo, created }`.
   */
  async ensureRepo(
    slug: string,
    metadata: { description: string; homepage: string },
  ): Promise<{ repo: GitHubRepo; created: boolean }> {
    const existing = await this.getRepo(slug);
    if (!existing) {
      const createdRepo = await this.createOrgRepo(slug, {
        description: metadata.description,
        homepage: metadata.homepage,
        autoInit: false,
      });
      await this.setRepoTopics(slug, ["wordpress-plugin"]);
      return { repo: createdRepo, created: true };
    }

    const needsMetaUpdate =
      (metadata.description && existing.description !== metadata.description) ||
      (metadata.homepage && existing.homepage !== metadata.homepage);

    let updated = existing;
    if (needsMetaUpdate) {
      updated = await this.updateRepoMetadata(slug, {
        description: metadata.description,
        homepage: metadata.homepage,
      });
    }

    if (!existing.topics?.includes("wordpress-plugin")) {
      const mergedTopics = Array.from(
        new Set([...(existing.topics ?? []), "wordpress-plugin"]),
      );
      await this.setRepoTopics(slug, mergedTopics);
    }

    return { repo: updated, created: false };
  }
}
