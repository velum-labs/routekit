import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hash.ts";

interface TransferBundle {
  schemaVersion: 1;
  createdAt: string;
  files: Array<{ name: string; sha256: string; contentBase64: string }>;
}
interface EncryptedTransfer {
  schemaVersion: 1;
  algorithm: "AES-256-GCM+RSA-OAEP-SHA256";
  createdAt: string;
  encryptedKeyBase64: string;
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
  ciphertextSha256: string;
}

const safeName = (name: string): string => {
  const base = path.basename(name);
  if (!base || base === "." || base === "..") throw new Error(`Unsafe transfer filename: ${name}`);
  return base;
};

export const generateTransferKeyPair = async (privateKeyFile: string, publicKeyFile: string): Promise<void> => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await mkdir(path.dirname(privateKeyFile), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(publicKeyFile), { recursive: true, mode: 0o700 });
  await writeFile(privateKeyFile, privateKey, { mode: 0o600, flag: "wx" });
  await writeFile(publicKeyFile, publicKey, { mode: 0o644, flag: "wx" });
};

export const encryptTransfer = async (files: string[], publicKeyFile: string, outputFile: string): Promise<void> => {
  if (files.length === 0) throw new Error("At least one input file is required");
  const bundle: TransferBundle = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    files: await Promise.all(files.map(async (file) => {
      const content = await readFile(file);
      return { name: safeName(file), sha256: sha256(content), contentBase64: content.toString("base64") };
    })),
  };
  if (new Set(bundle.files.map((file) => file.name)).size !== bundle.files.length) throw new Error("Transfer input basenames must be unique");
  const plaintext = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const publicKey = await readFile(publicKeyFile, "utf8");
  const encryptedKey = publicEncrypt({ key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, key);
  const envelope: EncryptedTransfer = {
    schemaVersion: 1, algorithm: "AES-256-GCM+RSA-OAEP-SHA256", createdAt: new Date().toISOString(),
    encryptedKeyBase64: encryptedKey.toString("base64"), ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"), ciphertextBase64: ciphertext.toString("base64"),
    ciphertextSha256: sha256(ciphertext),
  };
  await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  await writeFile(outputFile, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: "wx" });
};

export const importTransfer = async (encryptedFile: string, privateKeyFile: string, outputDirectory: string): Promise<string[]> => {
  const privateInfo = await stat(privateKeyFile);
  if ((privateInfo.mode & 0o077) !== 0) throw new Error("Transfer private key must have mode 0600");
  const envelope = JSON.parse(await readFile(encryptedFile, "utf8")) as EncryptedTransfer;
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== "AES-256-GCM+RSA-OAEP-SHA256") throw new Error("Unsupported encrypted transfer");
  const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");
  if (sha256(ciphertext) !== envelope.ciphertextSha256) throw new Error("Ciphertext hash mismatch");
  const privateKey = await readFile(privateKeyFile, "utf8");
  const key = privateDecrypt({
    key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(envelope.encryptedKeyBase64, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTagBase64, "base64"));
  const bundle = JSON.parse(gunzipSync(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toString("utf8")) as TransferBundle;
  if (bundle.schemaVersion !== 1) throw new Error("Unsupported transfer bundle");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputs: string[] = [];
  for (const file of bundle.files) {
    const content = Buffer.from(file.contentBase64, "base64");
    if (sha256(content) !== file.sha256) throw new Error(`Plaintext hash mismatch: ${file.name}`);
    const output = path.join(outputDirectory, safeName(file.name));
    await writeFile(output, content, { mode: 0o600, flag: "wx" });
    await chmod(output, 0o600);
    outputs.push(output);
  }
  return outputs;
};
