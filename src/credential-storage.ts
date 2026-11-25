import { createStore, get, update } from "idb-keyval";

const keys = createStore("nyx-assistant-credentials", "keys");
const keyId = "aes-gcm-v1";
const prefix = "nyx-sealed:v1:";
const utf8 = new TextEncoder();

export function isSealed(record: string) {
  return record.startsWith(prefix);
}

async function encryptionKey() {
  const existing = await get<CryptoKey>(keyId, keys);
  if (existing) return existing;
  const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  let selected = candidate;
  // The read and conditional write share an IndexedDB transaction across tabs.
  await update<CryptoKey>(keyId, current => (selected = current ?? candidate), keys);
  return selected;
}

function encode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
}
function decode(text: string) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export async function sealCredential(binding: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(binding) }, await encryptionKey(), utf8.encode(value),
  );
  return prefix + encode(iv) + "." + encode(new Uint8Array(ciphertext));
}

export async function openCredential(binding: string, record: string) {
  const key = await get<CryptoKey>(keyId, keys);
  if (!key) return undefined;
  const fields = record.slice(prefix.length).split(".");
  if (fields.length !== 2) return undefined;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(fields[0]), additionalData: utf8.encode(binding) }, key, decode(fields[1]),
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof DOMException && ["InvalidCharacterError", "OperationError"].includes(error.name)) return undefined;
    throw error;
  }
}
