/**
 * Plugin `crypto` na @noble/hashes i @noble/ed25519.
 * Działa w przeglądarce/WebView, Node i Bun (Ed25519 przez sha512 z @noble/hashes, bez WebCrypto —
 * WebKitGTK nie zawsze ma Ed25519 w WebCrypto).
 *
 * @module @koko-anime/formats/crypto-noble
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { definePlugin } from '../plugin/index.ts';
import type { CryptoCapability, KokoPlugin } from '../core/plugin-types.ts';

ed.hashes.sha512 = sha512;

/** Plugin zwracany przez {@link nobleCrypto}. */
export interface NobleCryptoPlugin extends KokoPlugin {
  /** Kryptografia na @noble. */
  crypto: CryptoCapability;
}

/**
 * Plugin `crypto`: synchroniczne sha256 oraz podpis, weryfikacja i klucz publiczny Ed25519.
 *
 * @example
 * ```ts
 * defineConfig({ plugins: [nobleCrypto()] });
 * ```
 */
export function nobleCrypto(): NobleCryptoPlugin {
  return definePlugin({
    name: 'crypto-noble',
    crypto: {
      sha256: (data) => sha256(data),
      ed25519Sign: async (message, privateKey) => ed.sign(message, privateKey),
      ed25519Verify: async (message, signature, publicKey) => {
        try {
          return ed.verify(signature, message, publicKey);
        } catch {
          return false;
        }
      },
      ed25519PublicKey: async (privateKey) => ed.getPublicKey(privateKey),
    },
  });
}

/** Nowy losowy klucz prywatny Ed25519 (32 B). */
export function randomPrivateKey(): Uint8Array {
  return ed.utils.randomSecretKey();
}
