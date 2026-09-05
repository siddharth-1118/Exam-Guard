var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/verify-c67-concurrency.ts
var import_client = require("@prisma/client");
var import_perf_hooks = __toESM(require("perf_hooks"));

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/base64url.js
var import_node_buffer = require("node:buffer");

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/base64url.js
var encode = (input) => import_node_buffer.Buffer.from(input).toString("base64url");

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWTInvalid = class extends JOSEError {
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
};

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/is_key_object.js
var util = __toESM(require("node:util"), 1);
var is_key_object_default = (obj) => util.types.isKeyObject(obj);

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/webcrypto.js
var crypto = __toESM(require("node:crypto"), 1);
var util2 = __toESM(require("node:util"), 1);
var webcrypto2 = crypto.webcrypto;
var webcrypto_default = webcrypto2;
var isCryptoKey = (key2) => util2.types.isCryptoKey(key2);

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/crypto_key.js
function unusable(name, prop = "algorithm.name") {
  return new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
}
function isAlgorithm(algorithm, name) {
  return algorithm.name === name;
}
function getHashLength(hash) {
  return parseInt(hash.name.slice(4), 10);
}
function getNamedCurve(alg) {
  switch (alg) {
    case "ES256":
      return "P-256";
    case "ES384":
      return "P-384";
    case "ES512":
      return "P-521";
    default:
      throw new Error("unreachable");
  }
}
function checkUsage(key2, usages) {
  if (usages.length && !usages.some((expected) => key2.usages.includes(expected))) {
    let msg = "CryptoKey does not support this operation, its usages must include ";
    if (usages.length > 2) {
      const last = usages.pop();
      msg += `one of ${usages.join(", ")}, or ${last}.`;
    } else if (usages.length === 2) {
      msg += `one of ${usages[0]} or ${usages[1]}.`;
    } else {
      msg += `${usages[0]}.`;
    }
    throw new TypeError(msg);
  }
}
function checkSigCryptoKey(key2, alg, ...usages) {
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512": {
      if (!isAlgorithm(key2.algorithm, "HMAC"))
        throw unusable("HMAC");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key2.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "RS256":
    case "RS384":
    case "RS512": {
      if (!isAlgorithm(key2.algorithm, "RSASSA-PKCS1-v1_5"))
        throw unusable("RSASSA-PKCS1-v1_5");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key2.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      if (!isAlgorithm(key2.algorithm, "RSA-PSS"))
        throw unusable("RSA-PSS");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key2.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "EdDSA": {
      if (key2.algorithm.name !== "Ed25519" && key2.algorithm.name !== "Ed448") {
        throw unusable("Ed25519 or Ed448");
      }
      break;
    }
    case "Ed25519": {
      if (!isAlgorithm(key2.algorithm, "Ed25519"))
        throw unusable("Ed25519");
      break;
    }
    case "ES256":
    case "ES384":
    case "ES512": {
      if (!isAlgorithm(key2.algorithm, "ECDSA"))
        throw unusable("ECDSA");
      const expected = getNamedCurve(alg);
      const actual = key2.algorithm.namedCurve;
      if (actual !== expected)
        throw unusable(expected, "algorithm.namedCurve");
      break;
    }
    default:
      throw new TypeError("CryptoKey does not support this operation");
  }
  checkUsage(key2, usages);
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/invalid_key_input.js
function message(msg, actual, ...types4) {
  types4 = types4.filter(Boolean);
  if (types4.length > 2) {
    const last = types4.pop();
    msg += `one of type ${types4.join(", ")}, or ${last}.`;
  } else if (types4.length === 2) {
    msg += `one of type ${types4[0]} or ${types4[1]}.`;
  } else {
    msg += `of type ${types4[0]}.`;
  }
  if (actual == null) {
    msg += ` Received ${actual}`;
  } else if (typeof actual === "function" && actual.name) {
    msg += ` Received function ${actual.name}`;
  } else if (typeof actual === "object" && actual != null) {
    if (actual.constructor?.name) {
      msg += ` Received an instance of ${actual.constructor.name}`;
    }
  }
  return msg;
}
var invalid_key_input_default = (actual, ...types4) => {
  return message("Key must be ", actual, ...types4);
};
function withAlg(alg, actual, ...types4) {
  return message(`Key for the ${alg} algorithm must be `, actual, ...types4);
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/is_key_like.js
var is_key_like_default = (key2) => is_key_object_default(key2) || isCryptoKey(key2);
var types3 = ["KeyObject"];
if (globalThis.CryptoKey || webcrypto_default?.CryptoKey) {
  types3.push("CryptoKey");
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/is_disjoint.js
var isDisjoint = (...headers) => {
  const sources = headers.filter(Boolean);
  if (sources.length === 0 || sources.length === 1) {
    return true;
  }
  let acc;
  for (const header of sources) {
    const parameters = Object.keys(header);
    if (!acc || acc.size === 0) {
      acc = new Set(parameters);
      continue;
    }
    for (const parameter of parameters) {
      if (acc.has(parameter)) {
        return false;
      }
      acc.add(parameter);
    }
  }
  return true;
};
var is_disjoint_default = isDisjoint;

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/is_object.js
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}
function isObject(input) {
  if (!isObjectLike(input) || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(input) === null) {
    return true;
  }
  let proto = input;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(input) === proto;
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/get_named_curve.js
var import_node_crypto = require("node:crypto");

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/is_jwk.js
function isJWK(key2) {
  return isObject(key2) && typeof key2.kty === "string";
}
function isPrivateJWK(key2) {
  return key2.kty !== "oct" && typeof key2.d === "string";
}
function isPublicJWK(key2) {
  return key2.kty !== "oct" && typeof key2.d === "undefined";
}
function isSecretJWK(key2) {
  return isJWK(key2) && key2.kty === "oct" && typeof key2.k === "string";
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/get_named_curve.js
var namedCurveToJOSE = (namedCurve) => {
  switch (namedCurve) {
    case "prime256v1":
      return "P-256";
    case "secp384r1":
      return "P-384";
    case "secp521r1":
      return "P-521";
    case "secp256k1":
      return "secp256k1";
    default:
      throw new JOSENotSupported("Unsupported key curve for this operation");
  }
};
var getNamedCurve2 = (kee, raw) => {
  let key2;
  if (isCryptoKey(kee)) {
    key2 = import_node_crypto.KeyObject.from(kee);
  } else if (is_key_object_default(kee)) {
    key2 = kee;
  } else if (isJWK(kee)) {
    return kee.crv;
  } else {
    throw new TypeError(invalid_key_input_default(kee, ...types3));
  }
  if (key2.type === "secret") {
    throw new TypeError('only "private" or "public" type keys can be used for this operation');
  }
  switch (key2.asymmetricKeyType) {
    case "ed25519":
    case "ed448":
      return `Ed${key2.asymmetricKeyType.slice(2)}`;
    case "x25519":
    case "x448":
      return `X${key2.asymmetricKeyType.slice(1)}`;
    case "ec": {
      const namedCurve = key2.asymmetricKeyDetails.namedCurve;
      if (raw) {
        return namedCurve;
      }
      return namedCurveToJOSE(namedCurve);
    }
    default:
      throw new TypeError("Invalid asymmetric key type for this operation");
  }
};
var get_named_curve_default = getNamedCurve2;

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/check_key_length.js
var import_node_crypto2 = require("node:crypto");
var check_key_length_default = (key2, alg) => {
  let modulusLength;
  try {
    if (key2 instanceof import_node_crypto2.KeyObject) {
      modulusLength = key2.asymmetricKeyDetails?.modulusLength;
    } else {
      modulusLength = Buffer.from(key2.n, "base64url").byteLength << 3;
    }
  } catch {
  }
  if (typeof modulusLength !== "number" || modulusLength < 2048) {
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
  }
};

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/check_key_type.js
var tag = (key2) => key2?.[Symbol.toStringTag];
var jwkMatchesOp = (alg, key2, usage) => {
  if (key2.use !== void 0 && key2.use !== "sig") {
    throw new TypeError("Invalid key for this operation, when present its use must be sig");
  }
  if (key2.key_ops !== void 0 && key2.key_ops.includes?.(usage) !== true) {
    throw new TypeError(`Invalid key for this operation, when present its key_ops must include ${usage}`);
  }
  if (key2.alg !== void 0 && key2.alg !== alg) {
    throw new TypeError(`Invalid key for this operation, when present its alg must be ${alg}`);
  }
  return true;
};
var symmetricTypeCheck = (alg, key2, usage, allowJwk) => {
  if (key2 instanceof Uint8Array)
    return;
  if (allowJwk && isJWK(key2)) {
    if (isSecretJWK(key2) && jwkMatchesOp(alg, key2, usage))
      return;
    throw new TypeError(`JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present`);
  }
  if (!is_key_like_default(key2)) {
    throw new TypeError(withAlg(alg, key2, ...types3, "Uint8Array", allowJwk ? "JSON Web Key" : null));
  }
  if (key2.type !== "secret") {
    throw new TypeError(`${tag(key2)} instances for symmetric algorithms must be of type "secret"`);
  }
};
var asymmetricTypeCheck = (alg, key2, usage, allowJwk) => {
  if (allowJwk && isJWK(key2)) {
    switch (usage) {
      case "sign":
        if (isPrivateJWK(key2) && jwkMatchesOp(alg, key2, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation be a private JWK`);
      case "verify":
        if (isPublicJWK(key2) && jwkMatchesOp(alg, key2, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation be a public JWK`);
    }
  }
  if (!is_key_like_default(key2)) {
    throw new TypeError(withAlg(alg, key2, ...types3, allowJwk ? "JSON Web Key" : null));
  }
  if (key2.type === "secret") {
    throw new TypeError(`${tag(key2)} instances for asymmetric algorithms must not be of type "secret"`);
  }
  if (usage === "sign" && key2.type === "public") {
    throw new TypeError(`${tag(key2)} instances for asymmetric algorithm signing must be of type "private"`);
  }
  if (usage === "decrypt" && key2.type === "public") {
    throw new TypeError(`${tag(key2)} instances for asymmetric algorithm decryption must be of type "private"`);
  }
  if (key2.algorithm && usage === "verify" && key2.type === "private") {
    throw new TypeError(`${tag(key2)} instances for asymmetric algorithm verifying must be of type "public"`);
  }
  if (key2.algorithm && usage === "encrypt" && key2.type === "private") {
    throw new TypeError(`${tag(key2)} instances for asymmetric algorithm encryption must be of type "public"`);
  }
};
function checkKeyType(allowJwk, alg, key2, usage) {
  const symmetric = alg.startsWith("HS") || alg === "dir" || alg.startsWith("PBES2") || /^A\d{3}(?:GCM)?KW$/.test(alg);
  if (symmetric) {
    symmetricTypeCheck(alg, key2, usage, allowJwk);
  } else {
    asymmetricTypeCheck(alg, key2, usage, allowJwk);
  }
}
var check_key_type_default = checkKeyType.bind(void 0, false);
var checkKeyTypeWithJwk = checkKeyType.bind(void 0, true);

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/validate_crit.js
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0) {
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  }
  if (!protectedHeader || protectedHeader.crit === void 0) {
    return /* @__PURE__ */ new Set();
  }
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) {
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  }
  let recognized;
  if (recognizedOption !== void 0) {
    recognized = new Map([...Object.entries(recognizedOption), ...recognizedDefault.entries()]);
  } else {
    recognized = recognizedDefault;
  }
  for (const parameter of protectedHeader.crit) {
    if (!recognized.has(parameter)) {
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    }
    if (joseHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    }
    if (recognized.get(parameter) && protectedHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
    }
  }
  return new Set(protectedHeader.crit);
}
var validate_crit_default = validateCrit;

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/dsa_digest.js
function dsaDigest(alg) {
  switch (alg) {
    case "PS256":
    case "RS256":
    case "ES256":
    case "ES256K":
      return "sha256";
    case "PS384":
    case "RS384":
    case "ES384":
      return "sha384";
    case "PS512":
    case "RS512":
    case "ES512":
      return "sha512";
    case "Ed25519":
    case "EdDSA":
      return void 0;
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/node_key.js
var import_node_crypto3 = require("node:crypto");
var ecCurveAlgMap = /* @__PURE__ */ new Map([
  ["ES256", "P-256"],
  ["ES256K", "secp256k1"],
  ["ES384", "P-384"],
  ["ES512", "P-521"]
]);
function keyForCrypto(alg, key2) {
  let asymmetricKeyType;
  let asymmetricKeyDetails;
  let isJWK2;
  if (key2 instanceof import_node_crypto3.KeyObject) {
    asymmetricKeyType = key2.asymmetricKeyType;
    asymmetricKeyDetails = key2.asymmetricKeyDetails;
  } else {
    isJWK2 = true;
    switch (key2.kty) {
      case "RSA":
        asymmetricKeyType = "rsa";
        break;
      case "EC":
        asymmetricKeyType = "ec";
        break;
      case "OKP": {
        if (key2.crv === "Ed25519") {
          asymmetricKeyType = "ed25519";
          break;
        }
        if (key2.crv === "Ed448") {
          asymmetricKeyType = "ed448";
          break;
        }
        throw new TypeError("Invalid key for this operation, its crv must be Ed25519 or Ed448");
      }
      default:
        throw new TypeError("Invalid key for this operation, its kty must be RSA, OKP, or EC");
    }
  }
  let options;
  switch (alg) {
    case "Ed25519":
      if (asymmetricKeyType !== "ed25519") {
        throw new TypeError(`Invalid key for this operation, its asymmetricKeyType must be ed25519`);
      }
      break;
    case "EdDSA":
      if (!["ed25519", "ed448"].includes(asymmetricKeyType)) {
        throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be ed25519 or ed448");
      }
      break;
    case "RS256":
    case "RS384":
    case "RS512":
      if (asymmetricKeyType !== "rsa") {
        throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be rsa");
      }
      check_key_length_default(key2, alg);
      break;
    case "PS256":
    case "PS384":
    case "PS512":
      if (asymmetricKeyType === "rsa-pss") {
        const { hashAlgorithm, mgf1HashAlgorithm, saltLength } = asymmetricKeyDetails;
        const length = parseInt(alg.slice(-3), 10);
        if (hashAlgorithm !== void 0 && (hashAlgorithm !== `sha${length}` || mgf1HashAlgorithm !== hashAlgorithm)) {
          throw new TypeError(`Invalid key for this operation, its RSA-PSS parameters do not meet the requirements of "alg" ${alg}`);
        }
        if (saltLength !== void 0 && saltLength > length >> 3) {
          throw new TypeError(`Invalid key for this operation, its RSA-PSS parameter saltLength does not meet the requirements of "alg" ${alg}`);
        }
      } else if (asymmetricKeyType !== "rsa") {
        throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be rsa or rsa-pss");
      }
      check_key_length_default(key2, alg);
      options = {
        padding: import_node_crypto3.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: import_node_crypto3.constants.RSA_PSS_SALTLEN_DIGEST
      };
      break;
    case "ES256":
    case "ES256K":
    case "ES384":
    case "ES512": {
      if (asymmetricKeyType !== "ec") {
        throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be ec");
      }
      const actual = get_named_curve_default(key2);
      const expected = ecCurveAlgMap.get(alg);
      if (actual !== expected) {
        throw new TypeError(`Invalid key curve for the algorithm, its curve must be ${expected}, got ${actual}`);
      }
      options = { dsaEncoding: "ieee-p1363" };
      break;
    }
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
  if (isJWK2) {
    return { format: "jwk", key: key2, ...options };
  }
  return options ? { ...options, key: key2 } : key2;
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/sign.js
var crypto2 = __toESM(require("node:crypto"), 1);
var import_node_util = require("node:util");

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/hmac_digest.js
function hmacDigest(alg) {
  switch (alg) {
    case "HS256":
      return "sha256";
    case "HS384":
      return "sha384";
    case "HS512":
      return "sha512";
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/get_sign_verify_key.js
var import_node_crypto4 = require("node:crypto");
function getSignVerifyKey(alg, key2, usage) {
  if (key2 instanceof Uint8Array) {
    if (!alg.startsWith("HS")) {
      throw new TypeError(invalid_key_input_default(key2, ...types3));
    }
    return (0, import_node_crypto4.createSecretKey)(key2);
  }
  if (key2 instanceof import_node_crypto4.KeyObject) {
    return key2;
  }
  if (isCryptoKey(key2)) {
    checkSigCryptoKey(key2, alg, usage);
    return import_node_crypto4.KeyObject.from(key2);
  }
  if (isJWK(key2)) {
    if (alg.startsWith("HS")) {
      return (0, import_node_crypto4.createSecretKey)(Buffer.from(key2.k, "base64url"));
    }
    return key2;
  }
  throw new TypeError(invalid_key_input_default(key2, ...types3, "Uint8Array", "JSON Web Key"));
}

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/runtime/sign.js
var oneShotSign = (0, import_node_util.promisify)(crypto2.sign);
var sign2 = async (alg, key2, data) => {
  const k = getSignVerifyKey(alg, key2, "sign");
  if (alg.startsWith("HS")) {
    const hmac = crypto2.createHmac(hmacDigest(alg), k);
    hmac.update(data);
    return hmac.digest();
  }
  return oneShotSign(dsaDigest(alg), data, keyForCrypto(alg, k));
};
var sign_default = sign2;

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/epoch.js
var epoch_default = (date) => Math.floor(date.getTime() / 1e3);

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/lib/secs.js
var minute = 60;
var hour = minute * 60;
var day = hour * 24;
var week = day * 7;
var year = day * 365.25;
var REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
var secs_default = (str) => {
  const matched = REGEX.exec(str);
  if (!matched || matched[4] && matched[1]) {
    throw new TypeError("Invalid time period format");
  }
  const value = parseFloat(matched[2]);
  const unit = matched[3].toLowerCase();
  let numericDate;
  switch (unit) {
    case "sec":
    case "secs":
    case "second":
    case "seconds":
    case "s":
      numericDate = Math.round(value);
      break;
    case "minute":
    case "minutes":
    case "min":
    case "mins":
    case "m":
      numericDate = Math.round(value * minute);
      break;
    case "hour":
    case "hours":
    case "hr":
    case "hrs":
    case "h":
      numericDate = Math.round(value * hour);
      break;
    case "day":
    case "days":
    case "d":
      numericDate = Math.round(value * day);
      break;
    case "week":
    case "weeks":
    case "w":
      numericDate = Math.round(value * week);
      break;
    default:
      numericDate = Math.round(value * year);
      break;
  }
  if (matched[1] === "-" || matched[4] === "ago") {
    return -numericDate;
  }
  return numericDate;
};

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/jws/flattened/sign.js
var FlattenedSign = class {
  _payload;
  _protectedHeader;
  _unprotectedHeader;
  constructor(payload) {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("payload must be an instance of Uint8Array");
    }
    this._payload = payload;
  }
  setProtectedHeader(protectedHeader) {
    if (this._protectedHeader) {
      throw new TypeError("setProtectedHeader can only be called once");
    }
    this._protectedHeader = protectedHeader;
    return this;
  }
  setUnprotectedHeader(unprotectedHeader) {
    if (this._unprotectedHeader) {
      throw new TypeError("setUnprotectedHeader can only be called once");
    }
    this._unprotectedHeader = unprotectedHeader;
    return this;
  }
  async sign(key2, options) {
    if (!this._protectedHeader && !this._unprotectedHeader) {
      throw new JWSInvalid("either setProtectedHeader or setUnprotectedHeader must be called before #sign()");
    }
    if (!is_disjoint_default(this._protectedHeader, this._unprotectedHeader)) {
      throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
    }
    const joseHeader = {
      ...this._protectedHeader,
      ...this._unprotectedHeader
    };
    const extensions = validate_crit_default(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, this._protectedHeader, joseHeader);
    let b64 = true;
    if (extensions.has("b64")) {
      b64 = this._protectedHeader.b64;
      if (typeof b64 !== "boolean") {
        throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
      }
    }
    const { alg } = joseHeader;
    if (typeof alg !== "string" || !alg) {
      throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
    }
    checkKeyTypeWithJwk(alg, key2, "sign");
    let payload = this._payload;
    if (b64) {
      payload = encoder.encode(encode(payload));
    }
    let protectedHeader;
    if (this._protectedHeader) {
      protectedHeader = encoder.encode(encode(JSON.stringify(this._protectedHeader)));
    } else {
      protectedHeader = encoder.encode("");
    }
    const data = concat(protectedHeader, encoder.encode("."), payload);
    const signature = await sign_default(alg, key2, data);
    const jws = {
      signature: encode(signature),
      payload: ""
    };
    if (b64) {
      jws.payload = decoder.decode(payload);
    }
    if (this._unprotectedHeader) {
      jws.header = this._unprotectedHeader;
    }
    if (this._protectedHeader) {
      jws.protected = decoder.decode(protectedHeader);
    }
    return jws;
  }
};

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/jws/compact/sign.js
var CompactSign = class {
  _flattened;
  constructor(payload) {
    this._flattened = new FlattenedSign(payload);
  }
  setProtectedHeader(protectedHeader) {
    this._flattened.setProtectedHeader(protectedHeader);
    return this;
  }
  async sign(key2, options) {
    const jws = await this._flattened.sign(key2, options);
    if (jws.payload === void 0) {
      throw new TypeError("use the flattened module for creating JWS with b64: false");
    }
    return `${jws.protected}.${jws.payload}.${jws.signature}`;
  }
};

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/jwt/produce.js
function validateInput(label, input) {
  if (!Number.isFinite(input)) {
    throw new TypeError(`Invalid ${label} input`);
  }
  return input;
}
var ProduceJWT = class {
  _payload;
  constructor(payload = {}) {
    if (!isObject(payload)) {
      throw new TypeError("JWT Claims Set MUST be an object");
    }
    this._payload = payload;
  }
  setIssuer(issuer) {
    this._payload = { ...this._payload, iss: issuer };
    return this;
  }
  setSubject(subject) {
    this._payload = { ...this._payload, sub: subject };
    return this;
  }
  setAudience(audience) {
    this._payload = { ...this._payload, aud: audience };
    return this;
  }
  setJti(jwtId) {
    this._payload = { ...this._payload, jti: jwtId };
    return this;
  }
  setNotBefore(input) {
    if (typeof input === "number") {
      this._payload = { ...this._payload, nbf: validateInput("setNotBefore", input) };
    } else if (input instanceof Date) {
      this._payload = { ...this._payload, nbf: validateInput("setNotBefore", epoch_default(input)) };
    } else {
      this._payload = { ...this._payload, nbf: epoch_default(/* @__PURE__ */ new Date()) + secs_default(input) };
    }
    return this;
  }
  setExpirationTime(input) {
    if (typeof input === "number") {
      this._payload = { ...this._payload, exp: validateInput("setExpirationTime", input) };
    } else if (input instanceof Date) {
      this._payload = { ...this._payload, exp: validateInput("setExpirationTime", epoch_default(input)) };
    } else {
      this._payload = { ...this._payload, exp: epoch_default(/* @__PURE__ */ new Date()) + secs_default(input) };
    }
    return this;
  }
  setIssuedAt(input) {
    if (typeof input === "undefined") {
      this._payload = { ...this._payload, iat: epoch_default(/* @__PURE__ */ new Date()) };
    } else if (input instanceof Date) {
      this._payload = { ...this._payload, iat: validateInput("setIssuedAt", epoch_default(input)) };
    } else if (typeof input === "string") {
      this._payload = {
        ...this._payload,
        iat: validateInput("setIssuedAt", epoch_default(/* @__PURE__ */ new Date()) + secs_default(input))
      };
    } else {
      this._payload = { ...this._payload, iat: validateInput("setIssuedAt", input) };
    }
    return this;
  }
};

// node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/node/esm/jwt/sign.js
var SignJWT = class extends ProduceJWT {
  _protectedHeader;
  setProtectedHeader(protectedHeader) {
    this._protectedHeader = protectedHeader;
    return this;
  }
  async sign(key2, options) {
    const sig = new CompactSign(encoder.encode(JSON.stringify(this._payload)));
    sig.setProtectedHeader(this._protectedHeader);
    if (Array.isArray(this._protectedHeader?.crit) && this._protectedHeader.crit.includes("b64") && this._protectedHeader.b64 === false) {
      throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
    }
    return sig.sign(key2, options);
  }
};

// packages/auth/src/index.ts
var encoder2 = new TextEncoder();
function key(secret) {
  return encoder2.encode(secret);
}
async function signAccessToken(claims, secret, ttlSeconds) {
  return new SignJWT({ ...claims, type: "access" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${ttlSeconds}s`).sign(key(secret));
}

// scripts/verify-c67-concurrency.ts
var API_BASE = "http://localhost:4000";
var DATABASE_URL = process.env.DATABASE_URL || "postgresql://examguard:examguard@localhost:5433/examguard?schema=public";
var prisma = new import_client.PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
async function postJson(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const start = import_perf_hooks.default.performance.now();
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const end = import_perf_hooks.default.performance.now();
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
    }
    return { status: res.status, ok: res.ok, json, durationMs: end - start };
  } catch (err) {
    const end = import_perf_hooks.default.performance.now();
    return { status: 0, ok: false, json: null, error: err.message, durationMs: end - start };
  }
}
async function getJson(url, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const start = import_perf_hooks.default.performance.now();
  try {
    const res = await fetch(url, { method: "GET", headers });
    const end = import_perf_hooks.default.performance.now();
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
    }
    return { status: res.status, ok: res.ok, json, durationMs: end - start };
  } catch (err) {
    const end = import_perf_hooks.default.performance.now();
    return { status: 0, ok: false, json: null, error: err.message, durationMs: end - start };
  }
}
async function testConcurrencyLevel(count, examId, orgId) {
  console.log(`
--- Testing Concurrency Level: N = ${count} Concurrent Students ---`);
  const latencies = [];
  let successfulStudents = 0;
  let failedStudents = 0;
  const attempts = [];
  const studentTokens = [];
  const jwtSecret = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
  const role = await prisma.role.findUnique({ where: { name: "STUDENT" } });
  for (let i = 0; i < count; i++) {
    const email = `conc_student_${i}@northstar.edu`;
    const code = `NS-CONC-${String(i).padStart(3, "0")}`;
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          firstName: "ConcStudent",
          lastName: `${i}`,
          passwordHash: "$2b$10$wT.48006w/y.e/w.e/w.e/w.e/w.e/w.e/w.e/w.e/w.e/w.e/w",
          isActive: true
        }
      });
    }
    if (role) {
      await prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
        update: { roleId: role.id, isActive: true },
        create: { organizationId: orgId, userId: user.id, roleId: role.id }
      });
    }
    const student = await prisma.student.upsert({
      where: { userId: user.id },
      update: { organizationId: orgId, studentCode: code },
      create: { userId: user.id, organizationId: orgId, studentCode: code }
    });
    await prisma.examAssignment.upsert({
      where: { examId_studentId: { examId, studentId: student.id } },
      update: {},
      create: { examId, studentId: student.id }
    });
    await prisma.examAttempt.deleteMany({ where: { studentId: student.id, examId } });
    const token = await signAccessToken(
      { sub: user.id, email, orgId, role: "STUDENT" },
      jwtSecret,
      3600
    );
    studentTokens.push({ token, email, userId: user.id });
  }
  const startPromises = studentTokens.map(async (item) => {
    const res = await postJson(`${API_BASE}/api/v1/attempts`, {
      examId,
      consent: { identityVerified: true, consentGiven: true }
    }, item.token);
    latencies.push(res.durationMs);
    if (res.ok && res.json?.attempt) {
      successfulStudents++;
      attempts.push(res.json.attempt.id);
      const mediaTokenRes = await postJson(`${API_BASE}/api/v1/media/token`, {
        attemptId: res.json.attempt.id
      }, item.token);
      latencies.push(mediaTokenRes.durationMs);
    } else {
      console.log(`\u274C Attempt start failed for ${item.email}: status=${res.status}`, res.json || res.error);
      failedStudents++;
    }
  });
  await Promise.all(startPromises);
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const memoryUsageMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const sfuStatus = await getJson("http://127.0.0.1:4010/status");
  console.log(`Results for N = ${count}:`);
  console.log(`  Successful Students: ${successfulStudents}/${count}`);
  console.log(`  Failed Students:     ${failedStudents}`);
  console.log(`  API Latency p50:      ${p50.toFixed(1)} ms`);
  console.log(`  API Latency p95:      ${p95.toFixed(1)} ms`);
  console.log(`  API Latency p99:      ${p99.toFixed(1)} ms`);
  console.log(`  Node Process Memory:  ${memoryUsageMB} MB`);
  console.log(`  SFU Active Rooms:     ${sfuStatus.json?.metrics?.rooms ?? 0}`);
  for (const attemptId of attempts) {
    try {
      await prisma.examAttempt.delete({ where: { id: attemptId } });
    } catch {
    }
  }
  return {
    count,
    successfulStudents,
    failedStudents,
    p50,
    p95,
    p99,
    memoryUsageMB,
    sfuRooms: sfuStatus.json?.metrics?.rooms ?? 0
  };
}
async function runC67Concurrency() {
  console.log("=== STARTING C67 MULTI-STUDENT CONCURRENCY BENCHMARK ===");
  try {
    const exam = await prisma.exam.findFirst({ where: { name: { contains: "Midterm" } } });
    if (!exam) throw new Error("Seeded exam not found");
    const levels = [2, 5, 10, 25, 50, 100];
    const summary = [];
    for (const N of levels) {
      const res = await testConcurrencyLevel(N, exam.id, exam.organizationId);
      summary.push(res);
      if (res.failedStudents > N * 0.5) {
        console.log(`\u26A0\uFE0F Concurrency bottleneck encountered at N = ${N}. Stopping scale.`);
        break;
      }
    }
    console.log("\n=== FINAL CONCURRENCY BENCHMARK SUMMARY ===");
    console.table(summary);
  } catch (err) {
    console.error("\u274C C67 BENCHMARK FAILED:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}
runC67Concurrency();
