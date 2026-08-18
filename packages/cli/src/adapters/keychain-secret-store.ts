import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type KeychainRunner = (args: readonly string[]) => Promise<string>;

async function runSecurity(args: readonly string[]): Promise<string> {
  const result = await execFileAsync("security", [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5_000
  });
  return result.stdout.trim();
}

function missingSecret(error: unknown): boolean {
  const candidate = error as { stderr?: string | Buffer };
  const stderr =
    typeof candidate.stderr === "string"
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr)
        ? candidate.stderr.toString("utf8")
        : "";
  return /could not be found|specified item.*not.*found/i.test(stderr);
}

export class KeychainSecretStore {
  readonly #service: string;
  readonly #run: KeychainRunner;

  constructor(service: string, run: KeychainRunner = runSecurity) {
    this.#service = service;
    this.#run = run;
  }

  async write(account: string, secret: string): Promise<void> {
    await this.#run([
      "add-generic-password",
      "-U",
      "-s",
      this.#service,
      "-a",
      account,
      "-w",
      secret
    ]);
  }

  async read(account: string): Promise<string | undefined> {
    try {
      const secret = await this.#run([
        "find-generic-password",
        "-s",
        this.#service,
        "-a",
        account,
        "-w"
      ]);
      return secret.length > 0 ? secret : undefined;
    } catch (error) {
      if (missingSecret(error)) return undefined;
      throw error;
    }
  }

  async delete(account: string): Promise<boolean> {
    try {
      await this.#run(["delete-generic-password", "-s", this.#service, "-a", account]);
      return true;
    } catch (error) {
      if (missingSecret(error)) return false;
      throw error;
    }
  }
}
