import { logger } from "../logger";
import type { schema } from "../db";
import type { TransportResult } from "./delivery";

/**
 * SFTP transport for the PUDO daily push. PUDO operators that don't
 * want an attachment-style email (Paxi historically preferred a
 * straight directory drop for their warehouse-management ingest
 * job) point us at an SFTP endpoint instead.
 *
 * Implementation note — `ssh2-sftp-client` is loaded via dynamic
 * import so the api-server doesn't carry a heavy native-binding dep
 * for deployments that only use the email transport. If the package
 * isn't installed AND a partner is configured for SFTP, the run
 * fails-clean with `errorCode="sftp_module_unavailable"` — which the
 * delivery orchestrator pages on like any other transport failure,
 * so operators get a clear "install the dep" signal instead of a
 * silent skip.
 *
 * Credentials are read from env (never persisted) — the partner row
 * stores only the *name* of the env var (`sftp_password_env_var` /
 * `sftp_key_env_var`) so a database dump never leaks SFTP secrets.
 * Private-key auth wins over password when both are configured.
 */
export interface SftpTransportArgs {
  partner: typeof schema.pudoPartnersTable.$inferSelect;
  forDate: string;
  csv: string;
}

interface SftpClient {
  connect(opts: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    readyTimeout?: number;
  }): Promise<unknown>;
  put(input: Buffer | string, remotePath: string): Promise<unknown>;
  end(): Promise<unknown>;
}

type SftpModule = { default: new () => SftpClient };

/** Cache the resolved module so repeated ticks don't pay the import cost.
 *  `null` = not yet attempted, `false` = attempted and absent. */
let sftpModuleCache: SftpModule | false | null = null;

async function loadSftpModule(): Promise<SftpModule | false> {
  if (sftpModuleCache !== null) return sftpModuleCache;
  try {
    // The package isn't a declared dependency (we want zero impact on
    // installs that only use the email transport), so we route through
    // a string variable to keep TypeScript from trying to resolve it
    // at build time. Operators that opt into SFTP push install the
    // module separately and the `import()` succeeds at runtime.
    const moduleName = "ssh2-sftp-client";
    const mod = (await import(moduleName)) as unknown as SftpModule;
    sftpModuleCache = mod;
    return mod;
  } catch {
    sftpModuleCache = false;
    return false;
  }
}

/**
 * Test seam: lets the unit test inject a fake `ssh2-sftp-client`
 * module without spawning a real SFTP server. Pass `null` to reset.
 */
export function __setSftpModuleForTesting(mod: SftpModule | false | null): void {
  sftpModuleCache = mod;
}

export async function sendManifestSftp(
  args: SftpTransportArgs,
): Promise<TransportResult> {
  const { partner, forDate, csv } = args;
  if (!partner.sftpHost || !partner.sftpUsername) {
    return {
      ok: false,
      destination: `sftp:${partner.sftpHost}:${partner.sftpRemoteDir}`,
      errorCode: "not_configured",
      errorMessage: "sftpHost / sftpUsername unset",
    };
  }

  const password = partner.sftpPasswordEnvVar
    ? process.env[partner.sftpPasswordEnvVar]
    : undefined;
  const privateKey = partner.sftpKeyEnvVar
    ? process.env[partner.sftpKeyEnvVar]
    : undefined;
  if (!password && !privateKey) {
    return {
      ok: false,
      destination: `sftp:${partner.sftpHost}:${partner.sftpRemoteDir}`,
      errorCode: "no_credentials",
      errorMessage: "neither sftpPasswordEnvVar nor sftpKeyEnvVar resolved",
    };
  }

  const mod = await loadSftpModule();
  if (mod === false) {
    return {
      ok: false,
      destination: `sftp:${partner.sftpHost}:${partner.sftpRemoteDir}`,
      errorCode: "sftp_module_unavailable",
      errorMessage:
        "ssh2-sftp-client is not installed; add it to api-server dependencies to enable SFTP push",
    };
  }

  const client = new mod.default();
  const remoteDir = partner.sftpRemoteDir.replace(/\/+$/, "") || "/";
  const remotePath =
    remoteDir === "/"
      ? `/${partner.code}-${forDate}.csv`
      : `${remoteDir}/${partner.code}-${forDate}.csv`;
  const destination = `sftp:${partner.sftpHost}:${remotePath}`;

  try {
    await client.connect({
      host: partner.sftpHost,
      port: partner.sftpPort,
      username: partner.sftpUsername,
      ...(privateKey ? { privateKey } : { password }),
      readyTimeout: 15_000,
    });
    await client.put(Buffer.from(csv, "utf8"), remotePath);
    await client.end().catch(() => undefined);
    return { ok: true, destination };
  } catch (err) {
    // Best-effort cleanup — `end()` on an already-broken connection
    // can throw; swallow that so the original transport error wins.
    await client.end().catch(() => undefined);
    logger.warn(
      {
        partnerCode: partner.code,
        host: partner.sftpHost,
        err: (err as Error).message,
      },
      "pudo_manifest_sftp_failed",
    );
    return {
      ok: false,
      destination,
      errorCode: "sftp_error",
      errorMessage: (err as Error).message,
    };
  }
}
