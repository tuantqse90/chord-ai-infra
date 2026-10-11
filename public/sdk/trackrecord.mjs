var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// node_modules/abitype/dist/esm/regex.js
function execTyped(regex, string) {
  const match = regex.exec(string);
  return match?.groups;
}
var bytesRegex, integerRegex, isTupleRegex;
var init_regex = __esm(() => {
  bytesRegex = /^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])?$/;
  integerRegex = /^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/;
  isTupleRegex = /^\(.+?\).*?$/;
});

// node_modules/abitype/dist/esm/human-readable/formatAbiParameter.js
function formatAbiParameter(abiParameter) {
  let type = abiParameter.type;
  if (tupleRegex.test(abiParameter.type) && "components" in abiParameter) {
    type = "(";
    const length = abiParameter.components.length;
    for (let i = 0;i < length; i++) {
      const component = abiParameter.components[i];
      type += formatAbiParameter(component);
      if (i < length - 1)
        type += ", ";
    }
    const result = execTyped(tupleRegex, abiParameter.type);
    type += `)${result?.array || ""}`;
    return formatAbiParameter({
      ...abiParameter,
      type
    });
  }
  if ("indexed" in abiParameter && abiParameter.indexed)
    type = `${type} indexed`;
  if (abiParameter.name)
    return `${type} ${abiParameter.name}`;
  return type;
}
var tupleRegex;
var init_formatAbiParameter = __esm(() => {
  init_regex();
  tupleRegex = /^tuple(?<array>(\[(\d*)\])*)$/;
});

// node_modules/abitype/dist/esm/human-readable/formatAbiParameters.js
function formatAbiParameters(abiParameters) {
  let params = "";
  const length = abiParameters.length;
  for (let i = 0;i < length; i++) {
    const abiParameter = abiParameters[i];
    params += formatAbiParameter(abiParameter);
    if (i !== length - 1)
      params += ", ";
  }
  return params;
}
var init_formatAbiParameters = __esm(() => {
  init_formatAbiParameter();
});

// node_modules/abitype/dist/esm/human-readable/formatAbiItem.js
function formatAbiItem(abiItem) {
  if (abiItem.type === "function")
    return `function ${abiItem.name}(${formatAbiParameters(abiItem.inputs)})${abiItem.stateMutability && abiItem.stateMutability !== "nonpayable" ? ` ${abiItem.stateMutability}` : ""}${abiItem.outputs?.length ? ` returns (${formatAbiParameters(abiItem.outputs)})` : ""}`;
  if (abiItem.type === "event")
    return `event ${abiItem.name}(${formatAbiParameters(abiItem.inputs)})`;
  if (abiItem.type === "error")
    return `error ${abiItem.name}(${formatAbiParameters(abiItem.inputs)})`;
  if (abiItem.type === "constructor")
    return `constructor(${formatAbiParameters(abiItem.inputs)})${abiItem.stateMutability === "payable" ? " payable" : ""}`;
  if (abiItem.type === "fallback")
    return `fallback() external${abiItem.stateMutability === "payable" ? " payable" : ""}`;
  return "receive() external payable";
}
var init_formatAbiItem = __esm(() => {
  init_formatAbiParameters();
});

// node_modules/abitype/dist/esm/human-readable/runtime/signatures.js
function isErrorSignature(signature) {
  return errorSignatureRegex.test(signature);
}
function execErrorSignature(signature) {
  return execTyped(errorSignatureRegex, signature);
}
function isEventSignature(signature) {
  return eventSignatureRegex.test(signature);
}
function execEventSignature(signature) {
  return execTyped(eventSignatureRegex, signature);
}
function isFunctionSignature(signature) {
  return functionSignatureRegex.test(signature);
}
function execFunctionSignature(signature) {
  return execTyped(functionSignatureRegex, signature);
}
function isStructSignature(signature) {
  return structSignatureRegex.test(signature);
}
function execStructSignature(signature) {
  return execTyped(structSignatureRegex, signature);
}
function isConstructorSignature(signature) {
  return constructorSignatureRegex.test(signature);
}
function execConstructorSignature(signature) {
  return execTyped(constructorSignatureRegex, signature);
}
function isFallbackSignature(signature) {
  return fallbackSignatureRegex.test(signature);
}
function execFallbackSignature(signature) {
  return execTyped(fallbackSignatureRegex, signature);
}
function isReceiveSignature(signature) {
  return receiveSignatureRegex.test(signature);
}
var errorSignatureRegex, eventSignatureRegex, functionSignatureRegex, structSignatureRegex, constructorSignatureRegex, fallbackSignatureRegex, receiveSignatureRegex, modifiers, eventModifiers, functionModifiers;
var init_signatures = __esm(() => {
  init_regex();
  errorSignatureRegex = /^error (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*)\((?<parameters>.*?)\)$/;
  eventSignatureRegex = /^event (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*)\((?<parameters>.*?)\)$/;
  functionSignatureRegex = /^function (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*)\((?<parameters>.*?)\)(?: (?<scope>external|public{1}))?(?: (?<stateMutability>pure|view|nonpayable|payable{1}))?(?: returns\s?\((?<returns>.*?)\))?$/;
  structSignatureRegex = /^struct (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*) \{(?<properties>.*?)\}$/;
  constructorSignatureRegex = /^constructor\((?<parameters>.*?)\)(?:\s(?<stateMutability>payable{1}))?$/;
  fallbackSignatureRegex = /^fallback\(\) external(?:\s(?<stateMutability>payable{1}))?$/;
  receiveSignatureRegex = /^receive\(\) external payable$/;
  modifiers = new Set([
    "memory",
    "indexed",
    "storage",
    "calldata"
  ]);
  eventModifiers = new Set(["indexed"]);
  functionModifiers = new Set([
    "calldata",
    "memory",
    "storage"
  ]);
});

// node_modules/abitype/dist/esm/version.js
var version = "1.2.3";

// node_modules/abitype/dist/esm/errors.js
var BaseError;
var init_errors = __esm(() => {
  BaseError = class BaseError extends Error {
    constructor(shortMessage, args = {}) {
      const details = args.cause instanceof BaseError ? args.cause.details : args.cause?.message ? args.cause.message : args.details;
      const docsPath = args.cause instanceof BaseError ? args.cause.docsPath || args.docsPath : args.docsPath;
      const message = [
        shortMessage || "An error occurred.",
        "",
        ...args.metaMessages ? [...args.metaMessages, ""] : [],
        ...docsPath ? [`Docs: https://abitype.dev${docsPath}`] : [],
        ...details ? [`Details: ${details}`] : [],
        `Version: abitype@${version}`
      ].join(`
`);
      super(message);
      Object.defineProperty(this, "details", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "docsPath", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "metaMessages", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "shortMessage", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "AbiTypeError"
      });
      if (args.cause)
        this.cause = args.cause;
      this.details = details;
      this.docsPath = docsPath;
      this.metaMessages = args.metaMessages;
      this.shortMessage = shortMessage;
    }
  };
});

// node_modules/abitype/dist/esm/human-readable/errors/abiItem.js
var UnknownTypeError, UnknownSolidityTypeError;
var init_abiItem = __esm(() => {
  init_errors();
  UnknownTypeError = class UnknownTypeError extends BaseError {
    constructor({ type }) {
      super("Unknown type.", {
        metaMessages: [
          `Type "${type}" is not a valid ABI type. Perhaps you forgot to include a struct signature?`
        ]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "UnknownTypeError"
      });
    }
  };
  UnknownSolidityTypeError = class UnknownSolidityTypeError extends BaseError {
    constructor({ type }) {
      super("Unknown type.", {
        metaMessages: [`Type "${type}" is not a valid ABI type.`]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "UnknownSolidityTypeError"
      });
    }
  };
});

// node_modules/abitype/dist/esm/human-readable/errors/abiParameter.js
var InvalidParameterError, SolidityProtectedKeywordError, InvalidModifierError, InvalidFunctionModifierError, InvalidAbiTypeParameterError;
var init_abiParameter = __esm(() => {
  init_errors();
  InvalidParameterError = class InvalidParameterError extends BaseError {
    constructor({ param }) {
      super("Invalid ABI parameter.", {
        details: param
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidParameterError"
      });
    }
  };
  SolidityProtectedKeywordError = class SolidityProtectedKeywordError extends BaseError {
    constructor({ param, name }) {
      super("Invalid ABI parameter.", {
        details: param,
        metaMessages: [
          `"${name}" is a protected Solidity keyword. More info: https://docs.soliditylang.org/en/latest/cheatsheet.html`
        ]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "SolidityProtectedKeywordError"
      });
    }
  };
  InvalidModifierError = class InvalidModifierError extends BaseError {
    constructor({ param, type, modifier }) {
      super("Invalid ABI parameter.", {
        details: param,
        metaMessages: [
          `Modifier "${modifier}" not allowed${type ? ` in "${type}" type` : ""}.`
        ]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidModifierError"
      });
    }
  };
  InvalidFunctionModifierError = class InvalidFunctionModifierError extends BaseError {
    constructor({ param, type, modifier }) {
      super("Invalid ABI parameter.", {
        details: param,
        metaMessages: [
          `Modifier "${modifier}" not allowed${type ? ` in "${type}" type` : ""}.`,
          `Data location can only be specified for array, struct, or mapping types, but "${modifier}" was given.`
        ]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidFunctionModifierError"
      });
    }
  };
  InvalidAbiTypeParameterError = class InvalidAbiTypeParameterError extends BaseError {
    constructor({ abiParameter }) {
      super("Invalid ABI parameter.", {
        details: JSON.stringify(abiParameter, null, 2),
        metaMessages: ["ABI parameter type is invalid."]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidAbiTypeParameterError"
      });
    }
  };
});

// node_modules/abitype/dist/esm/human-readable/errors/signature.js
var InvalidSignatureError, UnknownSignatureError, InvalidStructSignatureError;
var init_signature = __esm(() => {
  init_errors();
  InvalidSignatureError = class InvalidSignatureError extends BaseError {
    constructor({ signature, type }) {
      super(`Invalid ${type} signature.`, {
        details: signature
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidSignatureError"
      });
    }
  };
  UnknownSignatureError = class UnknownSignatureError extends BaseError {
    constructor({ signature }) {
      super("Unknown signature.", {
        details: signature
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "UnknownSignatureError"
      });
    }
  };
  InvalidStructSignatureError = class InvalidStructSignatureError extends BaseError {
    constructor({ signature }) {
      super("Invalid struct signature.", {
        details: signature,
        metaMessages: ["No properties exist."]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidStructSignatureError"
      });
    }
  };
});

// node_modules/abitype/dist/esm/human-readable/errors/struct.js
var CircularReferenceError;
var init_struct = __esm(() => {
  init_errors();
  CircularReferenceError = class CircularReferenceError extends BaseError {
    constructor({ type }) {
      super("Circular reference detected.", {
        metaMessages: [`Struct "${type}" is a circular reference.`]
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "CircularReferenceError"
      });
    }
  };
});

// node_modules/abitype/dist/esm/human-readable/errors/splitParameters.js
var InvalidParenthesisError;
var init_splitParameters = __esm(() => {
  init_errors();
  InvalidParenthesisError = class InvalidParenthesisError extends BaseError {
    constructor({ current, depth }) {
      super("Unbalanced parentheses.", {
        metaMessages: [
          `"${current.trim()}" has too many ${depth > 0 ? "opening" : "closing"} parentheses.`
        ],
        details: `Depth "${depth}"`
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "InvalidParenthesisError"
      });
    }
  };
});

// node_modules/abitype/dist/esm/human-readable/runtime/cache.js
function getParameterCacheKey(param, type, structs) {
  let structKey = "";
  if (structs)
    for (const struct of Object.entries(structs)) {
      if (!struct)
        continue;
      let propertyKey = "";
      for (const property of struct[1]) {
        propertyKey += `[${property.type}${property.name ? `:${property.name}` : ""}]`;
      }
      structKey += `(${struct[0]}{${propertyKey}})`;
    }
  if (type)
    return `${type}:${param}${structKey}`;
  return `${param}${structKey}`;
}
var parameterCache;
var init_cache = __esm(() => {
  parameterCache = new Map([
    ["address", { type: "address" }],
    ["bool", { type: "bool" }],
    ["bytes", { type: "bytes" }],
    ["bytes32", { type: "bytes32" }],
    ["int", { type: "int256" }],
    ["int256", { type: "int256" }],
    ["string", { type: "string" }],
    ["uint", { type: "uint256" }],
    ["uint8", { type: "uint8" }],
    ["uint16", { type: "uint16" }],
    ["uint24", { type: "uint24" }],
    ["uint32", { type: "uint32" }],
    ["uint64", { type: "uint64" }],
    ["uint96", { type: "uint96" }],
    ["uint112", { type: "uint112" }],
    ["uint160", { type: "uint160" }],
    ["uint192", { type: "uint192" }],
    ["uint256", { type: "uint256" }],
    ["address owner", { type: "address", name: "owner" }],
    ["address to", { type: "address", name: "to" }],
    ["bool approved", { type: "bool", name: "approved" }],
    ["bytes _data", { type: "bytes", name: "_data" }],
    ["bytes data", { type: "bytes", name: "data" }],
    ["bytes signature", { type: "bytes", name: "signature" }],
    ["bytes32 hash", { type: "bytes32", name: "hash" }],
    ["bytes32 r", { type: "bytes32", name: "r" }],
    ["bytes32 root", { type: "bytes32", name: "root" }],
    ["bytes32 s", { type: "bytes32", name: "s" }],
    ["string name", { type: "string", name: "name" }],
    ["string symbol", { type: "string", name: "symbol" }],
    ["string tokenURI", { type: "string", name: "tokenURI" }],
    ["uint tokenId", { type: "uint256", name: "tokenId" }],
    ["uint8 v", { type: "uint8", name: "v" }],
    ["uint256 balance", { type: "uint256", name: "balance" }],
    ["uint256 tokenId", { type: "uint256", name: "tokenId" }],
    ["uint256 value", { type: "uint256", name: "value" }],
    [
      "event:address indexed from",
      { type: "address", name: "from", indexed: true }
    ],
    ["event:address indexed to", { type: "address", name: "to", indexed: true }],
    [
      "event:uint indexed tokenId",
      { type: "uint256", name: "tokenId", indexed: true }
    ],
    [
      "event:uint256 indexed tokenId",
      { type: "uint256", name: "tokenId", indexed: true }
    ]
  ]);
});

// node_modules/abitype/dist/esm/human-readable/runtime/utils.js
function parseSignature(signature, structs = {}) {
  if (isFunctionSignature(signature))
    return parseFunctionSignature(signature, structs);
  if (isEventSignature(signature))
    return parseEventSignature(signature, structs);
  if (isErrorSignature(signature))
    return parseErrorSignature(signature, structs);
  if (isConstructorSignature(signature))
    return parseConstructorSignature(signature, structs);
  if (isFallbackSignature(signature))
    return parseFallbackSignature(signature);
  if (isReceiveSignature(signature))
    return {
      type: "receive",
      stateMutability: "payable"
    };
  throw new UnknownSignatureError({ signature });
}
function parseFunctionSignature(signature, structs = {}) {
  const match = execFunctionSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "function" });
  const inputParams = splitParameters(match.parameters);
  const inputs = [];
  const inputLength = inputParams.length;
  for (let i = 0;i < inputLength; i++) {
    inputs.push(parseAbiParameter(inputParams[i], {
      modifiers: functionModifiers,
      structs,
      type: "function"
    }));
  }
  const outputs = [];
  if (match.returns) {
    const outputParams = splitParameters(match.returns);
    const outputLength = outputParams.length;
    for (let i = 0;i < outputLength; i++) {
      outputs.push(parseAbiParameter(outputParams[i], {
        modifiers: functionModifiers,
        structs,
        type: "function"
      }));
    }
  }
  return {
    name: match.name,
    type: "function",
    stateMutability: match.stateMutability ?? "nonpayable",
    inputs,
    outputs
  };
}
function parseEventSignature(signature, structs = {}) {
  const match = execEventSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "event" });
  const params = splitParameters(match.parameters);
  const abiParameters = [];
  const length = params.length;
  for (let i = 0;i < length; i++)
    abiParameters.push(parseAbiParameter(params[i], {
      modifiers: eventModifiers,
      structs,
      type: "event"
    }));
  return { name: match.name, type: "event", inputs: abiParameters };
}
function parseErrorSignature(signature, structs = {}) {
  const match = execErrorSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "error" });
  const params = splitParameters(match.parameters);
  const abiParameters = [];
  const length = params.length;
  for (let i = 0;i < length; i++)
    abiParameters.push(parseAbiParameter(params[i], { structs, type: "error" }));
  return { name: match.name, type: "error", inputs: abiParameters };
}
function parseConstructorSignature(signature, structs = {}) {
  const match = execConstructorSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "constructor" });
  const params = splitParameters(match.parameters);
  const abiParameters = [];
  const length = params.length;
  for (let i = 0;i < length; i++)
    abiParameters.push(parseAbiParameter(params[i], { structs, type: "constructor" }));
  return {
    type: "constructor",
    stateMutability: match.stateMutability ?? "nonpayable",
    inputs: abiParameters
  };
}
function parseFallbackSignature(signature) {
  const match = execFallbackSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "fallback" });
  return {
    type: "fallback",
    stateMutability: match.stateMutability ?? "nonpayable"
  };
}
function parseAbiParameter(param, options) {
  const parameterCacheKey = getParameterCacheKey(param, options?.type, options?.structs);
  if (parameterCache.has(parameterCacheKey))
    return parameterCache.get(parameterCacheKey);
  const isTuple = isTupleRegex.test(param);
  const match = execTyped(isTuple ? abiParameterWithTupleRegex : abiParameterWithoutTupleRegex, param);
  if (!match)
    throw new InvalidParameterError({ param });
  if (match.name && isSolidityKeyword(match.name))
    throw new SolidityProtectedKeywordError({ param, name: match.name });
  const name = match.name ? { name: match.name } : {};
  const indexed = match.modifier === "indexed" ? { indexed: true } : {};
  const structs = options?.structs ?? {};
  let type;
  let components = {};
  if (isTuple) {
    type = "tuple";
    const params = splitParameters(match.type);
    const components_ = [];
    const length = params.length;
    for (let i = 0;i < length; i++) {
      components_.push(parseAbiParameter(params[i], { structs }));
    }
    components = { components: components_ };
  } else if (match.type in structs) {
    type = "tuple";
    components = { components: structs[match.type] };
  } else if (dynamicIntegerRegex.test(match.type)) {
    type = `${match.type}256`;
  } else if (match.type === "address payable") {
    type = "address";
  } else {
    type = match.type;
    if (!(options?.type === "struct") && !isSolidityType(type))
      throw new UnknownSolidityTypeError({ type });
  }
  if (match.modifier) {
    if (!options?.modifiers?.has?.(match.modifier))
      throw new InvalidModifierError({
        param,
        type: options?.type,
        modifier: match.modifier
      });
    if (functionModifiers.has(match.modifier) && !isValidDataLocation(type, !!match.array))
      throw new InvalidFunctionModifierError({
        param,
        type: options?.type,
        modifier: match.modifier
      });
  }
  const abiParameter = {
    type: `${type}${match.array ?? ""}`,
    ...name,
    ...indexed,
    ...components
  };
  parameterCache.set(parameterCacheKey, abiParameter);
  return abiParameter;
}
function splitParameters(params, result = [], current = "", depth = 0) {
  const length = params.trim().length;
  for (let i = 0;i < length; i++) {
    const char = params[i];
    const tail = params.slice(i + 1);
    switch (char) {
      case ",":
        return depth === 0 ? splitParameters(tail, [...result, current.trim()]) : splitParameters(tail, result, `${current}${char}`, depth);
      case "(":
        return splitParameters(tail, result, `${current}${char}`, depth + 1);
      case ")":
        return splitParameters(tail, result, `${current}${char}`, depth - 1);
      default:
        return splitParameters(tail, result, `${current}${char}`, depth);
    }
  }
  if (current === "")
    return result;
  if (depth !== 0)
    throw new InvalidParenthesisError({ current, depth });
  result.push(current.trim());
  return result;
}
function isSolidityType(type) {
  return type === "address" || type === "bool" || type === "function" || type === "string" || bytesRegex.test(type) || integerRegex.test(type);
}
function isSolidityKeyword(name) {
  return name === "address" || name === "bool" || name === "function" || name === "string" || name === "tuple" || bytesRegex.test(name) || integerRegex.test(name) || protectedKeywordsRegex.test(name);
}
function isValidDataLocation(type, isArray) {
  return isArray || type === "bytes" || type === "string" || type === "tuple";
}
var abiParameterWithoutTupleRegex, abiParameterWithTupleRegex, dynamicIntegerRegex, protectedKeywordsRegex;
var init_utils = __esm(() => {
  init_regex();
  init_abiItem();
  init_abiParameter();
  init_signature();
  init_splitParameters();
  init_cache();
  init_signatures();
  abiParameterWithoutTupleRegex = /^(?<type>[a-zA-Z$_][a-zA-Z0-9$_]*(?:\spayable)?)(?<array>(?:\[\d*?\])+?)?(?:\s(?<modifier>calldata|indexed|memory|storage{1}))?(?:\s(?<name>[a-zA-Z$_][a-zA-Z0-9$_]*))?$/;
  abiParameterWithTupleRegex = /^\((?<type>.+?)\)(?<array>(?:\[\d*?\])+?)?(?:\s(?<modifier>calldata|indexed|memory|storage{1}))?(?:\s(?<name>[a-zA-Z$_][a-zA-Z0-9$_]*))?$/;
  dynamicIntegerRegex = /^u?int$/;
  protectedKeywordsRegex = /^(?:after|alias|anonymous|apply|auto|byte|calldata|case|catch|constant|copyof|default|defined|error|event|external|false|final|function|immutable|implements|in|indexed|inline|internal|let|mapping|match|memory|mutable|null|of|override|partial|private|promise|public|pure|reference|relocatable|return|returns|sizeof|static|storage|struct|super|supports|switch|this|true|try|typedef|typeof|var|view|virtual)$/;
});

// node_modules/abitype/dist/esm/human-readable/runtime/structs.js
function parseStructs(signatures) {
  const shallowStructs = {};
  const signaturesLength = signatures.length;
  for (let i = 0;i < signaturesLength; i++) {
    const signature = signatures[i];
    if (!isStructSignature(signature))
      continue;
    const match = execStructSignature(signature);
    if (!match)
      throw new InvalidSignatureError({ signature, type: "struct" });
    const properties = match.properties.split(";");
    const components = [];
    const propertiesLength = properties.length;
    for (let k = 0;k < propertiesLength; k++) {
      const property = properties[k];
      const trimmed = property.trim();
      if (!trimmed)
        continue;
      const abiParameter = parseAbiParameter(trimmed, {
        type: "struct"
      });
      components.push(abiParameter);
    }
    if (!components.length)
      throw new InvalidStructSignatureError({ signature });
    shallowStructs[match.name] = components;
  }
  const resolvedStructs = {};
  const entries = Object.entries(shallowStructs);
  const entriesLength = entries.length;
  for (let i = 0;i < entriesLength; i++) {
    const [name, parameters] = entries[i];
    resolvedStructs[name] = resolveStructs(parameters, shallowStructs);
  }
  return resolvedStructs;
}
function resolveStructs(abiParameters = [], structs = {}, ancestors = new Set) {
  const components = [];
  const length = abiParameters.length;
  for (let i = 0;i < length; i++) {
    const abiParameter = abiParameters[i];
    const isTuple = isTupleRegex.test(abiParameter.type);
    if (isTuple)
      components.push(abiParameter);
    else {
      const match = execTyped(typeWithoutTupleRegex, abiParameter.type);
      if (!match?.type)
        throw new InvalidAbiTypeParameterError({ abiParameter });
      const { array, type } = match;
      if (type in structs) {
        if (ancestors.has(type))
          throw new CircularReferenceError({ type });
        components.push({
          ...abiParameter,
          type: `tuple${array ?? ""}`,
          components: resolveStructs(structs[type], structs, new Set([...ancestors, type]))
        });
      } else {
        if (isSolidityType(type))
          components.push(abiParameter);
        else
          throw new UnknownTypeError({ type });
      }
    }
  }
  return components;
}
var typeWithoutTupleRegex;
var init_structs = __esm(() => {
  init_regex();
  init_abiItem();
  init_abiParameter();
  init_signature();
  init_struct();
  init_signatures();
  init_utils();
  typeWithoutTupleRegex = /^(?<type>[a-zA-Z$_][a-zA-Z0-9$_]*)(?<array>(?:\[\d*?\])+?)?$/;
});

// node_modules/abitype/dist/esm/human-readable/parseAbi.js
function parseAbi(signatures) {
  const structs = parseStructs(signatures);
  const abi = [];
  const length = signatures.length;
  for (let i = 0;i < length; i++) {
    const signature = signatures[i];
    if (isStructSignature(signature))
      continue;
    abi.push(parseSignature(signature, structs));
  }
  return abi;
}
var init_parseAbi = __esm(() => {
  init_signatures();
  init_structs();
  init_utils();
});

// node_modules/abitype/dist/esm/exports/index.js
var init_exports = __esm(() => {
  init_formatAbiItem();
  init_parseAbi();
});

// node_modules/viem/_esm/accounts/utils/parseAccount.js
function parseAccount(account) {
  if (typeof account === "string")
    return { address: account, type: "json-rpc" };
  return account;
}

// node_modules/viem/_esm/utils/stringify.js
var stringify = (value, replacer, space) => JSON.stringify(value, (key, value_) => {
  const value2 = typeof value_ === "bigint" ? value_.toString() : value_;
  return typeof replacer === "function" ? replacer(key, value2) : value2;
}, space);

// node_modules/viem/_esm/errors/version.js
var version2 = "2.57.3";

// node_modules/viem/_esm/errors/base.js
function walk(err, fn) {
  if (fn?.(err))
    return err;
  if (err && typeof err === "object" && "cause" in err && err.cause !== undefined)
    return walk(err.cause, fn);
  return fn ? null : err;
}
var errorConfig, BaseError3;
var init_base = __esm(() => {
  errorConfig = {
    getDocsUrl: ({ docsBaseUrl, docsPath = "", docsSlug }) => docsPath ? `${docsBaseUrl ?? "https://viem.sh"}${docsPath}${docsSlug ? `#${docsSlug}` : ""}` : undefined,
    version: `viem@${version2}`
  };
  BaseError3 = class BaseError3 extends Error {
    constructor(shortMessage, args = {}) {
      const details = (() => {
        if (args.cause instanceof BaseError3)
          return args.cause.details;
        if (args.cause?.message)
          return args.cause.message;
        return args.details;
      })();
      const docsPath = (() => {
        if (args.cause instanceof BaseError3)
          return args.cause.docsPath || args.docsPath;
        return args.docsPath;
      })();
      const docsUrl = errorConfig.getDocsUrl?.({ ...args, docsPath });
      const message = [
        shortMessage || "An error occurred.",
        "",
        ...args.metaMessages ? [...args.metaMessages, ""] : [],
        ...docsUrl ? [`Docs: ${docsUrl}`] : [],
        ...details ? [`Details: ${details}`] : [],
        ...errorConfig.version ? [`Version: ${errorConfig.version}`] : []
      ].join(`
`);
      super(message, args.cause ? { cause: args.cause } : undefined);
      Object.defineProperty(this, "details", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "docsPath", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "metaMessages", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "shortMessage", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "version", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "BaseError"
      });
      this.details = details;
      this.docsPath = docsPath;
      this.metaMessages = args.metaMessages;
      this.name = args.name ?? this.name;
      this.shortMessage = shortMessage;
      this.version = version2;
    }
    walk(fn) {
      return walk(this, fn);
    }
  };
});

// node_modules/viem/_esm/errors/utils.js
function getAbortError(signal) {
  if (signal?.reason)
    return signal.reason;
  if (typeof DOMException === "function")
    return new DOMException("This operation was aborted", "AbortError");
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}
function isAbortError(error) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
var getContractAddress = (address) => address, getUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password)
      return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
};

// node_modules/viem/_esm/errors/request.js
var HttpRequestError, ResponseBodyTooLargeError, RpcRequestError, TimeoutError;
var init_request = __esm(() => {
  init_base();
  HttpRequestError = class HttpRequestError extends BaseError3 {
    constructor({ body, cause, details, headers, status, url }) {
      super("HTTP request failed.", {
        cause,
        details,
        metaMessages: [
          status && `Status: ${status}`,
          `URL: ${getUrl(url)}`,
          body && `Request body: ${stringify(body)}`
        ].filter(Boolean),
        name: "HttpRequestError"
      });
      Object.defineProperty(this, "body", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "headers", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "status", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "url", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.body = body;
      this.headers = headers;
      this.status = status;
      this.url = url;
    }
  };
  ResponseBodyTooLargeError = class ResponseBodyTooLargeError extends BaseError3 {
    constructor({ maxSize, size: size2 }) {
      super("HTTP response body exceeded the size limit.", {
        metaMessages: [`Max: ${maxSize} bytes`, `Received: ${size2} bytes`],
        name: "ResponseBodyTooLargeError"
      });
      Object.defineProperty(this, "maxSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "size", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.maxSize = maxSize;
      this.size = size2;
    }
  };
  RpcRequestError = class RpcRequestError extends BaseError3 {
    constructor({ body, error, url }) {
      super("RPC Request failed.", {
        cause: error,
        details: error.message,
        metaMessages: [`URL: ${getUrl(url)}`, `Request body: ${stringify(body)}`],
        name: "RpcRequestError"
      });
      Object.defineProperty(this, "code", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "data", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "url", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.code = error.code;
      this.data = error.data;
      this.url = url;
    }
  };
  TimeoutError = class TimeoutError extends BaseError3 {
    constructor({ body, url }) {
      super("The request took too long to respond.", {
        details: "The request timed out.",
        metaMessages: [`URL: ${getUrl(url)}`, `Request body: ${stringify(body)}`],
        name: "TimeoutError"
      });
      Object.defineProperty(this, "url", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.url = url;
    }
  };
});

// node_modules/viem/_esm/utils/promise/withResolvers.js
function withResolvers() {
  let resolve = () => {
    return;
  };
  let reject = () => {
    return;
  };
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

// node_modules/viem/_esm/utils/promise/createBatchScheduler.js
function createBatchScheduler({ fn, id, shouldSplitBatch, wait = 0, sort }) {
  const exec = async () => {
    const scheduler = getScheduler();
    flush();
    const args = scheduler.map(({ args: args2 }) => args2);
    if (args.length === 0)
      return;
    fn(args).then((data) => {
      if (sort && Array.isArray(data))
        data.sort(sort);
      for (let i = 0;i < scheduler.length; i++) {
        const { resolve } = scheduler[i];
        resolve?.([data[i], data]);
      }
    }).catch((err) => {
      for (let i = 0;i < scheduler.length; i++) {
        const { reject } = scheduler[i];
        reject?.(err);
      }
    });
  };
  const flush = () => schedulerCache.delete(id);
  const getBatchedArgs = () => getScheduler().map(({ args }) => args);
  const getScheduler = () => schedulerCache.get(id) || [];
  const setScheduler = (item) => schedulerCache.set(id, [...getScheduler(), item]);
  return {
    flush,
    async schedule(args) {
      const { promise, resolve, reject } = withResolvers();
      const split = shouldSplitBatch?.([...getBatchedArgs(), args]);
      if (split)
        exec();
      const hasActiveScheduler = getScheduler().length > 0;
      if (hasActiveScheduler) {
        setScheduler({ args, resolve, reject });
        return promise;
      }
      setScheduler({ args, resolve, reject });
      setTimeout(exec, wait);
      return promise;
    }
  };
}
var schedulerCache;
var init_createBatchScheduler = __esm(() => {
  schedulerCache = /* @__PURE__ */ new Map;
});

// node_modules/viem/_esm/errors/rpc.js
var unknownErrorCode = -1, RpcError, ProviderRpcError, ParseRpcError, InvalidRequestRpcError, MethodNotFoundRpcError, InvalidParamsRpcError, InternalRpcError, InvalidInputRpcError, ResourceNotFoundRpcError, ResourceUnavailableRpcError, TransactionRejectedRpcError, MethodNotSupportedRpcError, LimitExceededRpcError, JsonRpcVersionUnsupportedError, UserRejectedRequestError, UnauthorizedProviderError, UnsupportedProviderMethodError, ProviderDisconnectedError, ChainDisconnectedError, SwitchChainError, UnsupportedNonOptionalCapabilityError, UnsupportedChainIdError, DuplicateIdError, UnknownBundleIdError, BundleTooLargeError, AtomicReadyWalletRejectedUpgradeError, AtomicityNotSupportedError, WalletConnectSessionSettlementError, UnknownRpcError;
var init_rpc = __esm(() => {
  init_base();
  init_request();
  RpcError = class RpcError extends BaseError3 {
    constructor(cause, { code, docsPath, metaMessages, name, shortMessage }) {
      super(shortMessage, {
        cause,
        docsPath,
        metaMessages: metaMessages || cause?.metaMessages,
        name: name || "RpcError"
      });
      Object.defineProperty(this, "code", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.name = name || cause.name;
      this.code = cause instanceof RpcRequestError ? cause.code : code ?? unknownErrorCode;
    }
  };
  ProviderRpcError = class ProviderRpcError extends RpcError {
    constructor(cause, options) {
      super(cause, options);
      Object.defineProperty(this, "data", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.data = options.data;
    }
  };
  ParseRpcError = class ParseRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: ParseRpcError.code,
        name: "ParseRpcError",
        shortMessage: "Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text."
      });
    }
  };
  Object.defineProperty(ParseRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32700
  });
  InvalidRequestRpcError = class InvalidRequestRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: InvalidRequestRpcError.code,
        name: "InvalidRequestRpcError",
        shortMessage: "JSON is not a valid request object."
      });
    }
  };
  Object.defineProperty(InvalidRequestRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32600
  });
  MethodNotFoundRpcError = class MethodNotFoundRpcError extends RpcError {
    constructor(cause, { method } = {}) {
      super(cause, {
        code: MethodNotFoundRpcError.code,
        name: "MethodNotFoundRpcError",
        shortMessage: `The method${method ? ` "${method}"` : ""} does not exist / is not available.`
      });
    }
  };
  Object.defineProperty(MethodNotFoundRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32601
  });
  InvalidParamsRpcError = class InvalidParamsRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: InvalidParamsRpcError.code,
        name: "InvalidParamsRpcError",
        shortMessage: [
          "Invalid parameters were provided to the RPC method.",
          "Double check you have provided the correct parameters."
        ].join(`
`)
      });
    }
  };
  Object.defineProperty(InvalidParamsRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32602
  });
  InternalRpcError = class InternalRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: InternalRpcError.code,
        name: "InternalRpcError",
        shortMessage: "An internal error was received."
      });
    }
  };
  Object.defineProperty(InternalRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32603
  });
  InvalidInputRpcError = class InvalidInputRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: InvalidInputRpcError.code,
        name: "InvalidInputRpcError",
        shortMessage: [
          "Missing or invalid parameters.",
          "Double check you have provided the correct parameters."
        ].join(`
`)
      });
    }
  };
  Object.defineProperty(InvalidInputRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32000
  });
  ResourceNotFoundRpcError = class ResourceNotFoundRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: ResourceNotFoundRpcError.code,
        name: "ResourceNotFoundRpcError",
        shortMessage: "Requested resource not found."
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "ResourceNotFoundRpcError"
      });
    }
  };
  Object.defineProperty(ResourceNotFoundRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32001
  });
  ResourceUnavailableRpcError = class ResourceUnavailableRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: ResourceUnavailableRpcError.code,
        name: "ResourceUnavailableRpcError",
        shortMessage: "Requested resource not available."
      });
    }
  };
  Object.defineProperty(ResourceUnavailableRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32002
  });
  TransactionRejectedRpcError = class TransactionRejectedRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: TransactionRejectedRpcError.code,
        name: "TransactionRejectedRpcError",
        shortMessage: "Transaction creation failed."
      });
    }
  };
  Object.defineProperty(TransactionRejectedRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32003
  });
  MethodNotSupportedRpcError = class MethodNotSupportedRpcError extends RpcError {
    constructor(cause, { method } = {}) {
      super(cause, {
        code: MethodNotSupportedRpcError.code,
        name: "MethodNotSupportedRpcError",
        shortMessage: `Method${method ? ` "${method}"` : ""} is not supported.`
      });
    }
  };
  Object.defineProperty(MethodNotSupportedRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32004
  });
  LimitExceededRpcError = class LimitExceededRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: LimitExceededRpcError.code,
        name: "LimitExceededRpcError",
        shortMessage: "Request exceeds defined limit."
      });
    }
  };
  Object.defineProperty(LimitExceededRpcError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32005
  });
  JsonRpcVersionUnsupportedError = class JsonRpcVersionUnsupportedError extends RpcError {
    constructor(cause) {
      super(cause, {
        code: JsonRpcVersionUnsupportedError.code,
        name: "JsonRpcVersionUnsupportedError",
        shortMessage: "Version of JSON-RPC protocol is not supported."
      });
    }
  };
  Object.defineProperty(JsonRpcVersionUnsupportedError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: -32006
  });
  UserRejectedRequestError = class UserRejectedRequestError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: UserRejectedRequestError.code,
        name: "UserRejectedRequestError",
        shortMessage: "User rejected the request."
      });
    }
  };
  Object.defineProperty(UserRejectedRequestError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 4001
  });
  UnauthorizedProviderError = class UnauthorizedProviderError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: UnauthorizedProviderError.code,
        name: "UnauthorizedProviderError",
        shortMessage: "The requested method and/or account has not been authorized by the user."
      });
    }
  };
  Object.defineProperty(UnauthorizedProviderError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 4100
  });
  UnsupportedProviderMethodError = class UnsupportedProviderMethodError extends ProviderRpcError {
    constructor(cause, { method } = {}) {
      super(cause, {
        code: UnsupportedProviderMethodError.code,
        name: "UnsupportedProviderMethodError",
        shortMessage: `The Provider does not support the requested method${method ? ` " ${method}"` : ""}.`
      });
    }
  };
  Object.defineProperty(UnsupportedProviderMethodError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 4200
  });
  ProviderDisconnectedError = class ProviderDisconnectedError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: ProviderDisconnectedError.code,
        name: "ProviderDisconnectedError",
        shortMessage: "The Provider is disconnected from all chains."
      });
    }
  };
  Object.defineProperty(ProviderDisconnectedError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 4900
  });
  ChainDisconnectedError = class ChainDisconnectedError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: ChainDisconnectedError.code,
        name: "ChainDisconnectedError",
        shortMessage: "The Provider is not connected to the requested chain."
      });
    }
  };
  Object.defineProperty(ChainDisconnectedError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 4901
  });
  SwitchChainError = class SwitchChainError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: SwitchChainError.code,
        name: "SwitchChainError",
        shortMessage: "An error occurred when attempting to switch chain."
      });
    }
  };
  Object.defineProperty(SwitchChainError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 4902
  });
  UnsupportedNonOptionalCapabilityError = class UnsupportedNonOptionalCapabilityError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: UnsupportedNonOptionalCapabilityError.code,
        name: "UnsupportedNonOptionalCapabilityError",
        shortMessage: "This Wallet does not support a capability that was not marked as optional."
      });
    }
  };
  Object.defineProperty(UnsupportedNonOptionalCapabilityError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5700
  });
  UnsupportedChainIdError = class UnsupportedChainIdError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: UnsupportedChainIdError.code,
        name: "UnsupportedChainIdError",
        shortMessage: "This Wallet does not support the requested chain ID."
      });
    }
  };
  Object.defineProperty(UnsupportedChainIdError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5710
  });
  DuplicateIdError = class DuplicateIdError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: DuplicateIdError.code,
        name: "DuplicateIdError",
        shortMessage: "There is already a bundle submitted with this ID."
      });
    }
  };
  Object.defineProperty(DuplicateIdError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5720
  });
  UnknownBundleIdError = class UnknownBundleIdError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: UnknownBundleIdError.code,
        name: "UnknownBundleIdError",
        shortMessage: "This bundle id is unknown / has not been submitted"
      });
    }
  };
  Object.defineProperty(UnknownBundleIdError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5730
  });
  BundleTooLargeError = class BundleTooLargeError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: BundleTooLargeError.code,
        name: "BundleTooLargeError",
        shortMessage: "The call bundle is too large for the Wallet to process."
      });
    }
  };
  Object.defineProperty(BundleTooLargeError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5740
  });
  AtomicReadyWalletRejectedUpgradeError = class AtomicReadyWalletRejectedUpgradeError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: AtomicReadyWalletRejectedUpgradeError.code,
        name: "AtomicReadyWalletRejectedUpgradeError",
        shortMessage: "The Wallet can support atomicity after an upgrade, but the user rejected the upgrade."
      });
    }
  };
  Object.defineProperty(AtomicReadyWalletRejectedUpgradeError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5750
  });
  AtomicityNotSupportedError = class AtomicityNotSupportedError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: AtomicityNotSupportedError.code,
        name: "AtomicityNotSupportedError",
        shortMessage: "The wallet does not support atomic execution but the request requires it."
      });
    }
  };
  Object.defineProperty(AtomicityNotSupportedError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5760
  });
  WalletConnectSessionSettlementError = class WalletConnectSessionSettlementError extends ProviderRpcError {
    constructor(cause) {
      super(cause, {
        code: WalletConnectSessionSettlementError.code,
        name: "WalletConnectSessionSettlementError",
        shortMessage: "WalletConnect session settlement failed."
      });
    }
  };
  Object.defineProperty(WalletConnectSessionSettlementError, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 7000
  });
  UnknownRpcError = class UnknownRpcError extends RpcError {
    constructor(cause) {
      super(cause, {
        name: "UnknownRpcError",
        shortMessage: "An unknown RPC error occurred."
      });
    }
  };
});

// node_modules/viem/_esm/utils/lru.js
var LruMap;
var init_lru = __esm(() => {
  LruMap = class LruMap extends Map {
    constructor(size2) {
      super();
      Object.defineProperty(this, "maxSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.maxSize = size2;
    }
    get(key) {
      const value = super.get(key);
      if (super.has(key)) {
        super.delete(key);
        super.set(key, value);
      }
      return value;
    }
    set(key, value) {
      if (super.has(key))
        super.delete(key);
      super.set(key, value);
      if (this.maxSize && this.size > this.maxSize) {
        const firstKey = super.keys().next().value;
        if (firstKey !== undefined)
          super.delete(firstKey);
      }
      return this;
    }
  };
});

// node_modules/viem/_esm/errors/address.js
var InvalidAddressError;
var init_address = __esm(() => {
  init_base();
  InvalidAddressError = class InvalidAddressError extends BaseError3 {
    constructor({ address }) {
      super(`Address "${address}" is invalid.`, {
        metaMessages: [
          "- Address must be a hex value of 20 bytes (40 hex characters).",
          "- Address must match its checksum counterpart."
        ],
        name: "InvalidAddressError"
      });
    }
  };
});

// node_modules/viem/_esm/utils/data/isHex.js
function isHex(value, { strict = true } = {}) {
  if (!value)
    return false;
  if (typeof value !== "string")
    return false;
  return strict ? /^0x[0-9a-fA-F]*$/.test(value) : value.startsWith("0x");
}

// node_modules/viem/_esm/errors/data.js
var SliceOffsetOutOfBoundsError, SizeExceedsPaddingSizeError, InvalidBytesLengthError;
var init_data = __esm(() => {
  init_base();
  SliceOffsetOutOfBoundsError = class SliceOffsetOutOfBoundsError extends BaseError3 {
    constructor({ offset, position, size: size2 }) {
      super(`Slice ${position === "start" ? "starting" : "ending"} at offset "${offset}" is out-of-bounds (size: ${size2}).`, { name: "SliceOffsetOutOfBoundsError" });
    }
  };
  SizeExceedsPaddingSizeError = class SizeExceedsPaddingSizeError extends BaseError3 {
    constructor({ size: size2, targetSize, type }) {
      super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (${size2}) exceeds padding size (${targetSize}).`, { name: "SizeExceedsPaddingSizeError" });
    }
  };
  InvalidBytesLengthError = class InvalidBytesLengthError extends BaseError3 {
    constructor({ size: size2, targetSize, type }) {
      super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} is expected to be ${targetSize} ${type} long, but is ${size2} ${type} long.`, { name: "InvalidBytesLengthError" });
    }
  };
});

// node_modules/viem/_esm/utils/data/pad.js
function pad(hexOrBytes, { dir, size: size2 = 32 } = {}) {
  if (typeof hexOrBytes === "string")
    return padHex(hexOrBytes, { dir, size: size2 });
  return padBytes(hexOrBytes, { dir, size: size2 });
}
function padHex(hex_, { dir, size: size2 = 32 } = {}) {
  if (size2 === null)
    return hex_;
  const hex = hex_.replace("0x", "");
  if (hex.length > size2 * 2)
    throw new SizeExceedsPaddingSizeError({
      size: Math.ceil(hex.length / 2),
      targetSize: size2,
      type: "hex"
    });
  return `0x${hex[dir === "right" ? "padEnd" : "padStart"](size2 * 2, "0")}`;
}
function padBytes(bytes, { dir, size: size2 = 32 } = {}) {
  if (size2 === null)
    return bytes;
  if (bytes.length > size2)
    throw new SizeExceedsPaddingSizeError({
      size: bytes.length,
      targetSize: size2,
      type: "bytes"
    });
  const paddedBytes = new Uint8Array(size2);
  for (let i = 0;i < size2; i++) {
    const padEnd = dir === "right";
    paddedBytes[padEnd ? i : size2 - i - 1] = bytes[padEnd ? i : bytes.length - i - 1];
  }
  return paddedBytes;
}
var init_pad = __esm(() => {
  init_data();
});

// node_modules/viem/_esm/errors/encoding.js
var IntegerOutOfRangeError, InvalidBytesBooleanError, SizeOverflowError;
var init_encoding = __esm(() => {
  init_base();
  IntegerOutOfRangeError = class IntegerOutOfRangeError extends BaseError3 {
    constructor({ max, min, signed, size: size2, value }) {
      super(`Number "${value}" is not in safe ${size2 ? `${size2 * 8}-bit ${signed ? "signed" : "unsigned"} ` : ""}integer range ${max ? `(${min} to ${max})` : `(above ${min})`}`, { name: "IntegerOutOfRangeError" });
    }
  };
  InvalidBytesBooleanError = class InvalidBytesBooleanError extends BaseError3 {
    constructor(bytes) {
      super(`Bytes value "${bytes}" is not a valid boolean. The bytes array must contain a single byte of either a 0 or 1 value.`, {
        name: "InvalidBytesBooleanError"
      });
    }
  };
  SizeOverflowError = class SizeOverflowError extends BaseError3 {
    constructor({ givenSize, maxSize }) {
      super(`Size cannot exceed ${maxSize} bytes. Given size: ${givenSize} bytes.`, { name: "SizeOverflowError" });
    }
  };
});

// node_modules/viem/_esm/utils/data/size.js
function size2(value) {
  if (isHex(value, { strict: false }))
    return Math.ceil((value.length - 2) / 2);
  return value.length;
}
var init_size = () => {};

// node_modules/viem/_esm/utils/data/trim.js
function trim(hexOrBytes, { dir = "left" } = {}) {
  let data = typeof hexOrBytes === "string" ? hexOrBytes.replace("0x", "") : hexOrBytes;
  let sliceLength = 0;
  for (let i = 0;i < data.length - 1; i++) {
    if (data[dir === "left" ? i : data.length - i - 1].toString() === "0")
      sliceLength++;
    else
      break;
  }
  data = dir === "left" ? data.slice(sliceLength) : data.slice(0, data.length - sliceLength);
  if (typeof hexOrBytes === "string") {
    if (data.length === 1 && dir === "right")
      data = `${data}0`;
    return `0x${data.length % 2 === 1 ? `0${data}` : data}`;
  }
  return data;
}

// node_modules/viem/_esm/utils/encoding/fromHex.js
function assertSize(hexOrBytes, { size: size3 }) {
  if (size2(hexOrBytes) > size3)
    throw new SizeOverflowError({
      givenSize: size2(hexOrBytes),
      maxSize: size3
    });
}
function hexToBigInt(hex, opts = {}) {
  const { signed } = opts;
  if (opts.size)
    assertSize(hex, { size: opts.size });
  const value = BigInt(hex);
  if (!signed)
    return value;
  const size3 = Math.ceil((hex.length - 2) / 2);
  const max = (1n << BigInt(size3) * 8n - 1n) - 1n;
  if (value <= max)
    return value;
  return value - BigInt(`0x${"f".padStart(size3 * 2, "f")}`) - 1n;
}
function hexToNumber(hex, opts = {}) {
  const value = hexToBigInt(hex, opts);
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new IntegerOutOfRangeError({
      max: `${Number.MAX_SAFE_INTEGER}`,
      min: `${Number.MIN_SAFE_INTEGER}`,
      signed: opts.signed,
      size: opts.size,
      value: `${value}n`
    });
  return number;
}
var init_fromHex = __esm(() => {
  init_encoding();
  init_size();
});

// node_modules/viem/_esm/utils/encoding/toHex.js
function toHex(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToHex(value, opts);
  if (typeof value === "string") {
    return stringToHex(value, opts);
  }
  if (typeof value === "boolean")
    return boolToHex(value, opts);
  return bytesToHex(value, opts);
}
function boolToHex(value, opts = {}) {
  const hex = `0x${Number(value)}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad(hex, { size: opts.size });
  }
  return hex;
}
function bytesToHex(value, opts = {}) {
  let string = "";
  for (let i = 0;i < value.length; i++) {
    string += hexes[value[i]];
  }
  const hex = `0x${string}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad(hex, { dir: "right", size: opts.size });
  }
  return hex;
}
function numberToHex(value_, opts = {}) {
  const { signed, size: size3 } = opts;
  const value = BigInt(value_);
  let maxValue;
  if (size3) {
    if (signed)
      maxValue = (1n << BigInt(size3) * 8n - 1n) - 1n;
    else
      maxValue = 2n ** (BigInt(size3) * 8n) - 1n;
  } else if (typeof value_ === "number") {
    maxValue = BigInt(Number.MAX_SAFE_INTEGER);
  }
  const minValue = typeof maxValue === "bigint" && signed ? -maxValue - 1n : 0;
  if (maxValue && value > maxValue || value < minValue) {
    const suffix = typeof value_ === "bigint" ? "n" : "";
    throw new IntegerOutOfRangeError({
      max: maxValue ? `${maxValue}${suffix}` : undefined,
      min: `${minValue}${suffix}`,
      signed,
      size: size3,
      value: `${value_}${suffix}`
    });
  }
  const hex = `0x${(signed && value < 0 ? (1n << BigInt(size3 * 8)) + BigInt(value) : value).toString(16)}`;
  if (size3)
    return pad(hex, { size: size3 });
  return hex;
}
function stringToHex(value_, opts = {}) {
  const value = encoder.encode(value_);
  return bytesToHex(value, opts);
}
var hexes, encoder;
var init_toHex = __esm(() => {
  init_encoding();
  init_pad();
  init_fromHex();
  hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, "0"));
  encoder = /* @__PURE__ */ new TextEncoder;
});

// node_modules/viem/_esm/utils/encoding/toBytes.js
function toBytes(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToBytes(value, opts);
  if (typeof value === "boolean")
    return boolToBytes(value, opts);
  if (isHex(value))
    return hexToBytes(value, opts);
  return stringToBytes(value, opts);
}
function boolToBytes(value, opts = {}) {
  const bytes = new Uint8Array(1);
  bytes[0] = Number(value);
  if (typeof opts.size === "number") {
    assertSize(bytes, { size: opts.size });
    return pad(bytes, { size: opts.size });
  }
  return bytes;
}
function charCodeToBase16(char) {
  if (char >= charCodeMap.zero && char <= charCodeMap.nine)
    return char - charCodeMap.zero;
  if (char >= charCodeMap.A && char <= charCodeMap.F)
    return char - (charCodeMap.A - 10);
  if (char >= charCodeMap.a && char <= charCodeMap.f)
    return char - (charCodeMap.a - 10);
  return;
}
function hexToBytes(hex_, opts = {}) {
  let hex = hex_;
  if (opts.size) {
    assertSize(hex, { size: opts.size });
    hex = pad(hex, { dir: "right", size: opts.size });
  }
  let hexString = hex.slice(2);
  if (hexString.length % 2)
    hexString = `0${hexString}`;
  const length = hexString.length / 2;
  const bytes = new Uint8Array(length);
  for (let index2 = 0, j = 0;index2 < length; index2++) {
    const nibbleLeft = charCodeToBase16(hexString.charCodeAt(j++));
    const nibbleRight = charCodeToBase16(hexString.charCodeAt(j++));
    if (nibbleLeft === undefined || nibbleRight === undefined) {
      throw new BaseError3(`Invalid byte sequence ("${hexString[j - 2]}${hexString[j - 1]}" in "${hexString}").`);
    }
    bytes[index2] = nibbleLeft * 16 + nibbleRight;
  }
  return bytes;
}
function numberToBytes(value, opts) {
  const hex = numberToHex(value, opts);
  return hexToBytes(hex);
}
function stringToBytes(value, opts = {}) {
  const bytes = encoder2.encode(value);
  if (typeof opts.size === "number") {
    assertSize(bytes, { size: opts.size });
    return pad(bytes, { dir: "right", size: opts.size });
  }
  return bytes;
}
var encoder2, charCodeMap;
var init_toBytes = __esm(() => {
  init_base();
  init_pad();
  init_fromHex();
  init_toHex();
  encoder2 = /* @__PURE__ */ new TextEncoder;
  charCodeMap = {
    zero: 48,
    nine: 57,
    A: 65,
    F: 70,
    a: 97,
    f: 102
  };
});

// node_modules/@noble/hashes/esm/_u64.js
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0;i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var U32_MASK64, _32n, rotlSH = (h, l, s) => h << s | l >>> 32 - s, rotlSL = (h, l, s) => l << s | h >>> 32 - s, rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s, rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
var init__u64 = __esm(() => {
  U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  _32n = /* @__PURE__ */ BigInt(32);
});

// node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0;i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes2(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}

class Hash {
}
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes2(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
var isLE, swap32IfBE;
var init_utils2 = __esm(() => {
  /*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
  swap32IfBE = isLE ? (u) => u : byteSwap32;
});

// node_modules/@noble/hashes/esm/sha3.js
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds;round < 24; round++) {
    for (let x = 0;x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0;x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0;y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0;t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0;y < 50; y += 10) {
      for (let x = 0;x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0;x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var _0n, _1n, _2n, _7n, _256n, _0x71n, SHA3_PI, SHA3_ROTL, _SHA3_IOTA, IOTAS, SHA3_IOTA_H, SHA3_IOTA_L, rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s), rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s), Keccak, gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen)), keccak_256;
var init_sha3 = __esm(() => {
  init__u64();
  init_utils2();
  _0n = BigInt(0);
  _1n = BigInt(1);
  _2n = BigInt(2);
  _7n = BigInt(7);
  _256n = BigInt(256);
  _0x71n = BigInt(113);
  SHA3_PI = [];
  SHA3_ROTL = [];
  _SHA3_IOTA = [];
  for (let round = 0, R = _1n, x = 1, y = 0;round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI.push(2 * (5 * y + x));
    SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
    let t = _0n;
    for (let j = 0;j < 7; j++) {
      R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
      if (R & _2n)
        t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
    }
    _SHA3_IOTA.push(t);
  }
  IOTAS = split(_SHA3_IOTA, true);
  SHA3_IOTA_H = IOTAS[0];
  SHA3_IOTA_L = IOTAS[1];
  Keccak = class Keccak extends Hash {
    constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
      super();
      this.pos = 0;
      this.posOut = 0;
      this.finished = false;
      this.destroyed = false;
      this.enableXOF = false;
      this.blockLen = blockLen;
      this.suffix = suffix;
      this.outputLen = outputLen;
      this.enableXOF = enableXOF;
      this.rounds = rounds;
      anumber(outputLen);
      if (!(0 < blockLen && blockLen < 200))
        throw new Error("only keccak-f1600 function is supported");
      this.state = new Uint8Array(200);
      this.state32 = u32(this.state);
    }
    clone() {
      return this._cloneInto();
    }
    keccak() {
      swap32IfBE(this.state32);
      keccakP(this.state32, this.rounds);
      swap32IfBE(this.state32);
      this.posOut = 0;
      this.pos = 0;
    }
    update(data) {
      aexists(this);
      data = toBytes2(data);
      abytes(data);
      const { blockLen, state } = this;
      const len = data.length;
      for (let pos = 0;pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        for (let i = 0;i < take; i++)
          state[this.pos++] ^= data[pos++];
        if (this.pos === blockLen)
          this.keccak();
      }
      return this;
    }
    finish() {
      if (this.finished)
        return;
      this.finished = true;
      const { state, suffix, pos, blockLen } = this;
      state[pos] ^= suffix;
      if ((suffix & 128) !== 0 && pos === blockLen - 1)
        this.keccak();
      state[blockLen - 1] ^= 128;
      this.keccak();
    }
    writeInto(out) {
      aexists(this, false);
      abytes(out);
      this.finish();
      const bufferOut = this.state;
      const { blockLen } = this;
      for (let pos = 0, len = out.length;pos < len; ) {
        if (this.posOut >= blockLen)
          this.keccak();
        const take = Math.min(blockLen - this.posOut, len - pos);
        out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
        this.posOut += take;
        pos += take;
      }
      return out;
    }
    xofInto(out) {
      if (!this.enableXOF)
        throw new Error("XOF is not possible for this instance");
      return this.writeInto(out);
    }
    xof(bytes) {
      anumber(bytes);
      return this.xofInto(new Uint8Array(bytes));
    }
    digestInto(out) {
      aoutput(out, this);
      if (this.finished)
        throw new Error("digest() was already called");
      this.writeInto(out);
      this.destroy();
      return out;
    }
    digest() {
      return this.digestInto(new Uint8Array(this.outputLen));
    }
    destroy() {
      this.destroyed = true;
      clean(this.state);
    }
    _cloneInto(to) {
      const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
      to || (to = new Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
      to.state32.set(this.state32);
      to.pos = this.pos;
      to.posOut = this.posOut;
      to.finished = this.finished;
      to.rounds = rounds;
      to.suffix = suffix;
      to.outputLen = outputLen;
      to.enableXOF = enableXOF;
      to.destroyed = this.destroyed;
      return to;
    }
  };
  keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();
});

// node_modules/viem/_esm/utils/hash/keccak256.js
function keccak256(value, to_) {
  const to = to_ || "hex";
  const bytes = keccak_256(isHex(value, { strict: false }) ? toBytes(value) : value);
  if (to === "bytes")
    return bytes;
  return toHex(bytes);
}
var init_keccak256 = __esm(() => {
  init_sha3();
  init_toBytes();
  init_toHex();
});

// node_modules/viem/_esm/utils/address/getAddress.js
function checksumAddress(address_, chainId) {
  if (checksumAddressCache.has(`${address_}.${chainId}`))
    return checksumAddressCache.get(`${address_}.${chainId}`);
  const hexAddress = chainId ? `${chainId}${address_.toLowerCase()}` : address_.substring(2).toLowerCase();
  const hash = keccak256(stringToBytes(hexAddress), "bytes");
  const address = (chainId ? hexAddress.substring(`${chainId}0x`.length) : hexAddress).split("");
  for (let i = 0;i < 40; i += 2) {
    if (hash[i >> 1] >> 4 >= 8 && address[i]) {
      address[i] = address[i].toUpperCase();
    }
    if ((hash[i >> 1] & 15) >= 8 && address[i + 1]) {
      address[i + 1] = address[i + 1].toUpperCase();
    }
  }
  const result = `0x${address.join("")}`;
  checksumAddressCache.set(`${address_}.${chainId}`, result);
  return result;
}
var checksumAddressCache;
var init_getAddress = __esm(() => {
  init_toBytes();
  init_keccak256();
  init_lru();
  checksumAddressCache = /* @__PURE__ */ new LruMap(8192);
});

// node_modules/viem/_esm/utils/address/isAddress.js
function isAddress(address, options) {
  const { strict = true } = options ?? {};
  const cacheKey = `${address}.${strict}`;
  if (isAddressCache.has(cacheKey))
    return isAddressCache.get(cacheKey);
  const result = (() => {
    if (!addressRegex.test(address))
      return false;
    if (address.toLowerCase() === address)
      return true;
    if (strict)
      return checksumAddress(address) === address;
    return true;
  })();
  isAddressCache.set(cacheKey, result);
  return result;
}
var addressRegex, isAddressCache;
var init_isAddress = __esm(() => {
  init_lru();
  init_getAddress();
  addressRegex = /^0x[a-fA-F0-9]{40}$/;
  isAddressCache = /* @__PURE__ */ new LruMap(8192);
});

// node_modules/viem/_esm/utils/address/isAddressEqual.js
function isAddressEqual(a, b) {
  if (!isAddress(a, { strict: false }))
    throw new InvalidAddressError({ address: a });
  if (!isAddress(b, { strict: false }))
    throw new InvalidAddressError({ address: b });
  return a.toLowerCase() === b.toLowerCase();
}
var init_isAddressEqual = __esm(() => {
  init_address();
  init_isAddress();
});

// node_modules/viem/_esm/utils/hash/hashSignature.js
function hashSignature(sig) {
  return hash(sig);
}
var hash = (value) => keccak256(toBytes(value));
var init_hashSignature = __esm(() => {
  init_toBytes();
  init_keccak256();
});

// node_modules/viem/_esm/utils/hash/normalizeSignature.js
function normalizeSignature(signature) {
  let active = true;
  let current = "";
  let level = 0;
  let result = "";
  let valid = false;
  for (let i = 0;i < signature.length; i++) {
    const char = signature[i];
    if (["(", ")", ","].includes(char))
      active = true;
    if (char === "(")
      level++;
    if (char === ")")
      level--;
    if (!active)
      continue;
    if (level === 0) {
      if (char === " " && ["event", "function", ""].includes(result))
        result = "";
      else {
        result += char;
        if (char === ")") {
          valid = true;
          break;
        }
      }
      continue;
    }
    if (char === " ") {
      if (signature[i - 1] !== "," && current !== "," && current !== ",(") {
        current = "";
        active = false;
      }
      continue;
    }
    result += char;
    current += char;
  }
  if (!valid)
    throw new BaseError3("Unable to normalize signature.");
  return result;
}
var init_normalizeSignature = __esm(() => {
  init_base();
});

// node_modules/viem/_esm/utils/hash/toSignature.js
var toSignature = (def) => {
  const def_ = (() => {
    if (typeof def === "string")
      return def;
    return formatAbiItem(def);
  })();
  return normalizeSignature(def_);
};
var init_toSignature = __esm(() => {
  init_exports();
  init_normalizeSignature();
});

// node_modules/viem/_esm/utils/hash/toSignatureHash.js
function toSignatureHash(fn) {
  return hashSignature(toSignature(fn));
}
var init_toSignatureHash = __esm(() => {
  init_hashSignature();
  init_toSignature();
});

// node_modules/viem/_esm/utils/hash/toEventSelector.js
var toEventSelector;
var init_toEventSelector = __esm(() => {
  init_toSignatureHash();
  toEventSelector = toSignatureHash;
});

// node_modules/viem/_esm/utils/abi/formatAbiItem.js
function formatAbiItem2(abiItem, { includeName = false } = {}) {
  if (abiItem.type !== "function" && abiItem.type !== "event" && abiItem.type !== "error")
    throw new InvalidDefinitionTypeError(abiItem.type);
  return `${abiItem.name}(${formatAbiParams(abiItem.inputs, { includeName })})`;
}
function formatAbiParams(params, { includeName = false } = {}) {
  if (!params)
    return "";
  return params.map((param) => formatAbiParam(param, { includeName })).join(includeName ? ", " : ",");
}
function formatAbiParam(param, { includeName }) {
  if (param.type.startsWith("tuple")) {
    return `(${formatAbiParams(param.components, { includeName })})${param.type.slice("tuple".length)}`;
  }
  return param.type + (includeName && param.name ? ` ${param.name}` : "");
}
var init_formatAbiItem2 = __esm(() => {
  init_abi();
});

// node_modules/viem/_esm/errors/abi.js
var AbiConstructorNotFoundError, AbiConstructorParamsNotFoundError, AbiDecodingDataSizeTooSmallError, AbiDecodingZeroDataError, AbiEncodingArrayLengthMismatchError, AbiEncodingBytesSizeMismatchError, AbiEncodingLengthMismatchError, AbiErrorInputsNotFoundError, AbiErrorNotFoundError, AbiErrorSignatureNotFoundError, AbiEventSignatureEmptyTopicsError, AbiEventSignatureNotFoundError, AbiFunctionNotFoundError, AbiFunctionOutputsNotFoundError, AbiFunctionSignatureNotFoundError, AbiItemAmbiguityError, DecodeLogDataMismatch, DecodeLogTopicsMismatch, InvalidAbiEncodingTypeError, InvalidAbiDecodingTypeError, InvalidArrayError, InvalidDefinitionTypeError;
var init_abi = __esm(() => {
  init_formatAbiItem2();
  init_size();
  init_base();
  AbiConstructorNotFoundError = class AbiConstructorNotFoundError extends BaseError3 {
    constructor({ docsPath }) {
      super([
        "A constructor was not found on the ABI.",
        "Make sure you are using the correct ABI and that the constructor exists on it."
      ].join(`
`), {
        docsPath,
        name: "AbiConstructorNotFoundError"
      });
    }
  };
  AbiConstructorParamsNotFoundError = class AbiConstructorParamsNotFoundError extends BaseError3 {
    constructor({ docsPath }) {
      super([
        "Constructor arguments were provided (`args`), but a constructor parameters (`inputs`) were not found on the ABI.",
        "Make sure you are using the correct ABI, and that the `inputs` attribute on the constructor exists."
      ].join(`
`), {
        docsPath,
        name: "AbiConstructorParamsNotFoundError"
      });
    }
  };
  AbiDecodingDataSizeTooSmallError = class AbiDecodingDataSizeTooSmallError extends BaseError3 {
    constructor({ data, params, size: size3 }) {
      super([`Data size of ${size3} bytes is too small for given parameters.`].join(`
`), {
        metaMessages: [
          `Params: (${formatAbiParams(params, { includeName: true })})`,
          `Data:   ${data} (${size3} bytes)`
        ],
        name: "AbiDecodingDataSizeTooSmallError"
      });
      Object.defineProperty(this, "data", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "params", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "size", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.data = data;
      this.params = params;
      this.size = size3;
    }
  };
  AbiDecodingZeroDataError = class AbiDecodingZeroDataError extends BaseError3 {
    constructor({ cause } = {}) {
      super('Cannot decode zero data ("0x") with ABI parameters.', {
        name: "AbiDecodingZeroDataError",
        cause
      });
    }
  };
  AbiEncodingArrayLengthMismatchError = class AbiEncodingArrayLengthMismatchError extends BaseError3 {
    constructor({ expectedLength, givenLength, type }) {
      super([
        `ABI encoding array length mismatch for type ${type}.`,
        `Expected length: ${expectedLength}`,
        `Given length: ${givenLength}`
      ].join(`
`), { name: "AbiEncodingArrayLengthMismatchError" });
    }
  };
  AbiEncodingBytesSizeMismatchError = class AbiEncodingBytesSizeMismatchError extends BaseError3 {
    constructor({ expectedSize, value }) {
      super(`Size of bytes "${value}" (bytes${size2(value)}) does not match expected size (bytes${expectedSize}).`, { name: "AbiEncodingBytesSizeMismatchError" });
    }
  };
  AbiEncodingLengthMismatchError = class AbiEncodingLengthMismatchError extends BaseError3 {
    constructor({ expectedLength, givenLength }) {
      super([
        "ABI encoding params/values length mismatch.",
        `Expected length (params): ${expectedLength}`,
        `Given length (values): ${givenLength}`
      ].join(`
`), { name: "AbiEncodingLengthMismatchError" });
    }
  };
  AbiErrorInputsNotFoundError = class AbiErrorInputsNotFoundError extends BaseError3 {
    constructor(errorName, { docsPath }) {
      super([
        `Arguments (\`args\`) were provided to "${errorName}", but "${errorName}" on the ABI does not contain any parameters (\`inputs\`).`,
        "Cannot encode error result without knowing what the parameter types are.",
        "Make sure you are using the correct ABI and that the inputs exist on it."
      ].join(`
`), {
        docsPath,
        name: "AbiErrorInputsNotFoundError"
      });
    }
  };
  AbiErrorNotFoundError = class AbiErrorNotFoundError extends BaseError3 {
    constructor(errorName, { docsPath } = {}) {
      super([
        `Error ${errorName ? `"${errorName}" ` : ""}not found on ABI.`,
        "Make sure you are using the correct ABI and that the error exists on it."
      ].join(`
`), {
        docsPath,
        name: "AbiErrorNotFoundError"
      });
    }
  };
  AbiErrorSignatureNotFoundError = class AbiErrorSignatureNotFoundError extends BaseError3 {
    constructor(signature, { docsPath, cause }) {
      super([
        `Encoded error signature "${signature}" not found on ABI.`,
        "Make sure you are using the correct ABI and that the error exists on it.",
        `You can look up the decoded signature here: https://4byte.sourcify.dev/?q=${signature}.`
      ].join(`
`), {
        docsPath,
        name: "AbiErrorSignatureNotFoundError",
        cause
      });
      Object.defineProperty(this, "signature", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.signature = signature;
    }
  };
  AbiEventSignatureEmptyTopicsError = class AbiEventSignatureEmptyTopicsError extends BaseError3 {
    constructor({ docsPath }) {
      super("Cannot extract event signature from empty topics.", {
        docsPath,
        name: "AbiEventSignatureEmptyTopicsError"
      });
    }
  };
  AbiEventSignatureNotFoundError = class AbiEventSignatureNotFoundError extends BaseError3 {
    constructor(signature, { docsPath }) {
      super([
        `Encoded event signature "${signature}" not found on ABI.`,
        "Make sure you are using the correct ABI and that the event exists on it.",
        `You can look up the signature here: https://4byte.sourcify.dev/?q=${signature}.`
      ].join(`
`), {
        docsPath,
        name: "AbiEventSignatureNotFoundError"
      });
    }
  };
  AbiFunctionNotFoundError = class AbiFunctionNotFoundError extends BaseError3 {
    constructor(functionName, { docsPath } = {}) {
      super([
        `Function ${functionName ? `"${functionName}" ` : ""}not found on ABI.`,
        "Make sure you are using the correct ABI and that the function exists on it."
      ].join(`
`), {
        docsPath,
        name: "AbiFunctionNotFoundError"
      });
    }
  };
  AbiFunctionOutputsNotFoundError = class AbiFunctionOutputsNotFoundError extends BaseError3 {
    constructor(functionName, { docsPath }) {
      super([
        `Function "${functionName}" does not contain any \`outputs\` on ABI.`,
        "Cannot decode function result without knowing what the parameter types are.",
        "Make sure you are using the correct ABI and that the function exists on it."
      ].join(`
`), {
        docsPath,
        name: "AbiFunctionOutputsNotFoundError"
      });
    }
  };
  AbiFunctionSignatureNotFoundError = class AbiFunctionSignatureNotFoundError extends BaseError3 {
    constructor(signature, { docsPath }) {
      super([
        `Encoded function signature "${signature}" not found on ABI.`,
        "Make sure you are using the correct ABI and that the function exists on it.",
        `You can look up the signature here: https://4byte.sourcify.dev/?q=${signature}.`
      ].join(`
`), {
        docsPath,
        name: "AbiFunctionSignatureNotFoundError"
      });
    }
  };
  AbiItemAmbiguityError = class AbiItemAmbiguityError extends BaseError3 {
    constructor(x, y) {
      super("Found ambiguous types in overloaded ABI items.", {
        metaMessages: [
          `\`${x.type}\` in \`${formatAbiItem2(x.abiItem)}\`, and`,
          `\`${y.type}\` in \`${formatAbiItem2(y.abiItem)}\``,
          "",
          "These types encode differently and cannot be distinguished at runtime.",
          "Remove one of the ambiguous items in the ABI."
        ],
        name: "AbiItemAmbiguityError"
      });
    }
  };
  DecodeLogDataMismatch = class DecodeLogDataMismatch extends BaseError3 {
    constructor({ abiItem, data, params, size: size3 }) {
      super([
        `Data size of ${size3} bytes is too small for non-indexed event parameters.`
      ].join(`
`), {
        metaMessages: [
          `Params: (${formatAbiParams(params, { includeName: true })})`,
          `Data:   ${data} (${size3} bytes)`
        ],
        name: "DecodeLogDataMismatch"
      });
      Object.defineProperty(this, "abiItem", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "data", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "params", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "size", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.abiItem = abiItem;
      this.data = data;
      this.params = params;
      this.size = size3;
    }
  };
  DecodeLogTopicsMismatch = class DecodeLogTopicsMismatch extends BaseError3 {
    constructor({ abiItem, param }) {
      super([
        `Expected a topic for indexed event parameter${param.name ? ` "${param.name}"` : ""} on event "${formatAbiItem2(abiItem, { includeName: true })}".`
      ].join(`
`), { name: "DecodeLogTopicsMismatch" });
      Object.defineProperty(this, "abiItem", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.abiItem = abiItem;
    }
  };
  InvalidAbiEncodingTypeError = class InvalidAbiEncodingTypeError extends BaseError3 {
    constructor(type, { docsPath }) {
      super([
        `Type "${type}" is not a valid encoding type.`,
        "Please provide a valid ABI type."
      ].join(`
`), { docsPath, name: "InvalidAbiEncodingType" });
    }
  };
  InvalidAbiDecodingTypeError = class InvalidAbiDecodingTypeError extends BaseError3 {
    constructor(type, { docsPath }) {
      super([
        `Type "${type}" is not a valid decoding type.`,
        "Please provide a valid ABI type."
      ].join(`
`), { docsPath, name: "InvalidAbiDecodingType" });
    }
  };
  InvalidArrayError = class InvalidArrayError extends BaseError3 {
    constructor(value) {
      super([`Value "${value}" is not a valid array.`].join(`
`), {
        name: "InvalidArrayError"
      });
    }
  };
  InvalidDefinitionTypeError = class InvalidDefinitionTypeError extends BaseError3 {
    constructor(type) {
      super([
        `"${type}" is not a valid definition type.`,
        'Valid types: "function", "event", "error"'
      ].join(`
`), { name: "InvalidDefinitionTypeError" });
    }
  };
});

// node_modules/viem/_esm/errors/cursor.js
var NegativeOffsetError, PositionOutOfBoundsError, RecursiveReadLimitExceededError;
var init_cursor = __esm(() => {
  init_base();
  NegativeOffsetError = class NegativeOffsetError extends BaseError3 {
    constructor({ offset }) {
      super(`Offset \`${offset}\` cannot be negative.`, {
        name: "NegativeOffsetError"
      });
    }
  };
  PositionOutOfBoundsError = class PositionOutOfBoundsError extends BaseError3 {
    constructor({ length, position }) {
      super(`Position \`${position}\` is out of bounds (\`0 < position < ${length}\`).`, { name: "PositionOutOfBoundsError" });
    }
  };
  RecursiveReadLimitExceededError = class RecursiveReadLimitExceededError extends BaseError3 {
    constructor({ count, limit }) {
      super(`Recursive read limit of \`${limit}\` exceeded (recursive read count: \`${count}\`).`, { name: "RecursiveReadLimitExceededError" });
    }
  };
});

// node_modules/viem/_esm/utils/cursor.js
function createCursor(bytes, { recursiveReadLimit = 8192 } = {}) {
  const cursor = Object.create(staticCursor);
  cursor.bytes = bytes;
  cursor.dataView = new DataView(bytes.buffer ?? bytes, bytes.byteOffset, bytes.byteLength);
  cursor.positionReadCount = new Map;
  cursor.recursiveReadLimit = recursiveReadLimit;
  return cursor;
}
var staticCursor;
var init_cursor2 = __esm(() => {
  init_cursor();
  staticCursor = {
    bytes: new Uint8Array,
    dataView: new DataView(new ArrayBuffer(0)),
    position: 0,
    positionReadCount: new Map,
    recursiveReadCount: 0,
    recursiveReadLimit: Number.POSITIVE_INFINITY,
    assertReadLimit() {
      if (this.recursiveReadCount >= this.recursiveReadLimit)
        throw new RecursiveReadLimitExceededError({
          count: this.recursiveReadCount + 1,
          limit: this.recursiveReadLimit
        });
    },
    assertPosition(position) {
      if (position < 0 || position > this.bytes.length - 1)
        throw new PositionOutOfBoundsError({
          length: this.bytes.length,
          position
        });
    },
    decrementPosition(offset) {
      if (offset < 0)
        throw new NegativeOffsetError({ offset });
      const position = this.position - offset;
      this.assertPosition(position);
      this.position = position;
    },
    getReadCount(position) {
      return this.positionReadCount.get(position || this.position) || 0;
    },
    incrementPosition(offset) {
      if (offset < 0)
        throw new NegativeOffsetError({ offset });
      const position = this.position + offset;
      this.assertPosition(position);
      this.position = position;
    },
    inspectByte(position_) {
      const position = position_ ?? this.position;
      this.assertPosition(position);
      return this.bytes[position];
    },
    inspectBytes(length, position_) {
      const position = position_ ?? this.position;
      this.assertPosition(position + length - 1);
      return this.bytes.subarray(position, position + length);
    },
    inspectUint8(position_) {
      const position = position_ ?? this.position;
      this.assertPosition(position);
      return this.bytes[position];
    },
    inspectUint16(position_) {
      const position = position_ ?? this.position;
      this.assertPosition(position + 1);
      return this.dataView.getUint16(position);
    },
    inspectUint24(position_) {
      const position = position_ ?? this.position;
      this.assertPosition(position + 2);
      return (this.dataView.getUint16(position) << 8) + this.dataView.getUint8(position + 2);
    },
    inspectUint32(position_) {
      const position = position_ ?? this.position;
      this.assertPosition(position + 3);
      return this.dataView.getUint32(position);
    },
    pushByte(byte) {
      this.assertPosition(this.position);
      this.bytes[this.position] = byte;
      this.position++;
    },
    pushBytes(bytes) {
      this.assertPosition(this.position + bytes.length - 1);
      this.bytes.set(bytes, this.position);
      this.position += bytes.length;
    },
    pushUint8(value) {
      this.assertPosition(this.position);
      this.bytes[this.position] = value;
      this.position++;
    },
    pushUint16(value) {
      this.assertPosition(this.position + 1);
      this.dataView.setUint16(this.position, value);
      this.position += 2;
    },
    pushUint24(value) {
      this.assertPosition(this.position + 2);
      this.dataView.setUint16(this.position, value >> 8);
      this.dataView.setUint8(this.position + 2, value & ~4294967040);
      this.position += 3;
    },
    pushUint32(value) {
      this.assertPosition(this.position + 3);
      this.dataView.setUint32(this.position, value);
      this.position += 4;
    },
    readByte() {
      this.assertReadLimit();
      this._touch();
      const value = this.inspectByte();
      this.position++;
      return value;
    },
    readBytes(length, size3) {
      this.assertReadLimit();
      this._touch();
      const value = this.inspectBytes(length);
      this.position += size3 ?? length;
      return value;
    },
    readUint8() {
      this.assertReadLimit();
      this._touch();
      const value = this.inspectUint8();
      this.position += 1;
      return value;
    },
    readUint16() {
      this.assertReadLimit();
      this._touch();
      const value = this.inspectUint16();
      this.position += 2;
      return value;
    },
    readUint24() {
      this.assertReadLimit();
      this._touch();
      const value = this.inspectUint24();
      this.position += 3;
      return value;
    },
    readUint32() {
      this.assertReadLimit();
      this._touch();
      const value = this.inspectUint32();
      this.position += 4;
      return value;
    },
    get remaining() {
      return this.bytes.length - this.position;
    },
    setPosition(position) {
      const oldPosition = this.position;
      this.assertPosition(position);
      this.position = position;
      return () => this.position = oldPosition;
    },
    _touch() {
      if (this.recursiveReadLimit === Number.POSITIVE_INFINITY)
        return;
      const count = this.getReadCount();
      this.positionReadCount.set(this.position, count + 1);
      if (count > 0)
        this.recursiveReadCount++;
    }
  };
});

// node_modules/viem/_esm/utils/data/slice.js
function slice(value, start, end, { strict } = {}) {
  if (isHex(value, { strict: false }))
    return sliceHex(value, start, end, {
      strict
    });
  return sliceBytes(value, start, end, {
    strict
  });
}
function assertStartOffset(value, start) {
  if (typeof start === "number" && start > 0 && start > size2(value) - 1)
    throw new SliceOffsetOutOfBoundsError({
      offset: start,
      position: "start",
      size: size2(value)
    });
}
function assertEndOffset(value, start, end) {
  if (typeof start === "number" && typeof end === "number" && size2(value) !== end - start) {
    throw new SliceOffsetOutOfBoundsError({
      offset: end,
      position: "end",
      size: size2(value)
    });
  }
}
function sliceBytes(value_, start, end, { strict } = {}) {
  assertStartOffset(value_, start);
  const value = value_.slice(start, end);
  if (strict)
    assertEndOffset(value, start, end);
  return value;
}
function sliceHex(value_, start, end, { strict } = {}) {
  assertStartOffset(value_, start);
  const value = `0x${value_.replace("0x", "").slice((start ?? 0) * 2, (end ?? value_.length) * 2)}`;
  if (strict)
    assertEndOffset(value, start, end);
  return value;
}
var init_slice = __esm(() => {
  init_data();
  init_size();
});

// node_modules/viem/_esm/utils/encoding/fromBytes.js
function bytesToBigInt(bytes, opts = {}) {
  if (typeof opts.size !== "undefined")
    assertSize(bytes, { size: opts.size });
  const hex = bytesToHex(bytes);
  return hexToBigInt(hex, opts);
}
function bytesToBool(bytes_, opts = {}) {
  let bytes = bytes_;
  if (typeof opts.size !== "undefined") {
    assertSize(bytes, { size: opts.size });
    bytes = trim(bytes);
  }
  if (bytes.length > 1 || bytes[0] > 1)
    throw new InvalidBytesBooleanError(bytes);
  return Boolean(bytes[0]);
}
function bytesToNumber(bytes, opts = {}) {
  if (typeof opts.size !== "undefined")
    assertSize(bytes, { size: opts.size });
  const hex = bytesToHex(bytes);
  return hexToNumber(hex, opts);
}
function bytesToString(bytes_, opts = {}) {
  let bytes = bytes_;
  if (typeof opts.size !== "undefined") {
    assertSize(bytes, { size: opts.size });
    bytes = trim(bytes, { dir: "right" });
  }
  return new TextDecoder().decode(bytes);
}
var init_fromBytes = __esm(() => {
  init_encoding();
  init_fromHex();
  init_toHex();
});

// node_modules/viem/_esm/utils/data/concat.js
function concat(values) {
  if (typeof values[0] === "string")
    return concatHex(values);
  return concatBytes(values);
}
function concatBytes(values) {
  let length = 0;
  for (const arr of values) {
    length += arr.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const arr of values) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
function concatHex(values) {
  return `0x${values.reduce((acc, x) => acc + x.replace("0x", ""), "")}`;
}

// node_modules/viem/_esm/utils/regex.js
var integerRegex2;
var init_regex2 = __esm(() => {
  integerRegex2 = /^(u?int)(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/;
});

// node_modules/viem/_esm/utils/abi/encodeAbiParameters.js
function encodeAbiParameters(params, values) {
  if (params.length !== values.length)
    throw new AbiEncodingLengthMismatchError({
      expectedLength: params.length,
      givenLength: values.length
    });
  const preparedParams = prepareParams({
    params,
    values
  });
  return encodeParams(preparedParams);
}
function prepareParams({ params, values }) {
  const preparedParams = [];
  for (let i = 0;i < params.length; i++) {
    preparedParams.push(prepareParam({ param: params[i], value: values[i] }));
  }
  return preparedParams;
}
function prepareParam({ param, value }) {
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents) {
    const [length, type] = arrayComponents;
    return encodeArray(value, { length, param: { ...param, type } });
  }
  if (param.type === "tuple") {
    return encodeTuple(value, {
      param
    });
  }
  if (param.type === "address") {
    return encodeAddress(value);
  }
  if (param.type === "bool") {
    return encodeBool(value);
  }
  if (param.type.startsWith("uint") || param.type.startsWith("int")) {
    const signed = param.type.startsWith("int");
    const [, , size3 = "256"] = integerRegex2.exec(param.type) ?? [];
    return encodeNumber(value, {
      signed,
      size: Number(size3)
    });
  }
  if (param.type.startsWith("bytes")) {
    return encodeBytes(value, { param });
  }
  if (param.type === "string") {
    return encodeString(value);
  }
  throw new InvalidAbiEncodingTypeError(param.type, {
    docsPath: "/docs/contract/encodeAbiParameters"
  });
}
function encodeParams(preparedParams) {
  let staticSize = 0;
  for (let i = 0;i < preparedParams.length; i++) {
    const { dynamic, encoded } = preparedParams[i];
    if (dynamic)
      staticSize += 32;
    else
      staticSize += size2(encoded);
  }
  const staticParams = [];
  const dynamicParams = [];
  let dynamicSize = 0;
  for (let i = 0;i < preparedParams.length; i++) {
    const { dynamic, encoded } = preparedParams[i];
    if (dynamic) {
      staticParams.push(numberToHex(staticSize + dynamicSize, { size: 32 }));
      dynamicParams.push(encoded);
      dynamicSize += size2(encoded);
    } else {
      staticParams.push(encoded);
    }
  }
  return concatHex([...staticParams, ...dynamicParams]);
}
function encodeAddress(value) {
  if (!isAddress(value))
    throw new InvalidAddressError({ address: value });
  return { dynamic: false, encoded: padHex(value.toLowerCase()) };
}
function encodeArray(value, { length, param }) {
  const dynamic = length === null;
  if (!Array.isArray(value))
    throw new InvalidArrayError(value);
  if (!dynamic && value.length !== length)
    throw new AbiEncodingArrayLengthMismatchError({
      expectedLength: length,
      givenLength: value.length,
      type: `${param.type}[${length}]`
    });
  let dynamicChild = value.length === 0 && isDynamicType(param);
  const preparedParams = [];
  for (let i = 0;i < value.length; i++) {
    const preparedParam = prepareParam({ param, value: value[i] });
    if (preparedParam.dynamic)
      dynamicChild = true;
    preparedParams.push(preparedParam);
  }
  if (dynamic || dynamicChild) {
    const data = encodeParams(preparedParams);
    if (dynamic) {
      const length2 = numberToHex(preparedParams.length, { size: 32 });
      return {
        dynamic: true,
        encoded: concatHex([length2, data])
      };
    }
    if (dynamicChild)
      return { dynamic: true, encoded: data };
  }
  return {
    dynamic: false,
    encoded: concatHex(preparedParams.map(({ encoded }) => encoded))
  };
}
function encodeBytes(value, { param }) {
  const [, paramSize] = param.type.split("bytes");
  const bytesSize = size2(value);
  if (!paramSize) {
    let value_ = value;
    if (bytesSize % 32 !== 0)
      value_ = padHex(value_, {
        dir: "right",
        size: Math.ceil((value.length - 2) / 2 / 32) * 32
      });
    return {
      dynamic: true,
      encoded: concatHex([
        padHex(numberToHex(bytesSize, { size: 32 })),
        value_
      ])
    };
  }
  if (bytesSize !== Number.parseInt(paramSize, 10))
    throw new AbiEncodingBytesSizeMismatchError({
      expectedSize: Number.parseInt(paramSize, 10),
      value
    });
  return { dynamic: false, encoded: padHex(value, { dir: "right" }) };
}
function encodeBool(value) {
  if (typeof value !== "boolean")
    throw new BaseError3(`Invalid boolean value: "${value}" (type: ${typeof value}). Expected: \`true\` or \`false\`.`);
  return { dynamic: false, encoded: padHex(boolToHex(value)) };
}
function encodeNumber(value, { signed, size: size3 = 256 }) {
  if (typeof size3 === "number") {
    const max = 2n ** (BigInt(size3) - (signed ? 1n : 0n)) - 1n;
    const min = signed ? -max - 1n : 0n;
    if (value > max || value < min)
      throw new IntegerOutOfRangeError({
        max: max.toString(),
        min: min.toString(),
        signed,
        size: size3 / 8,
        value: value.toString()
      });
  }
  return {
    dynamic: false,
    encoded: numberToHex(value, {
      size: 32,
      signed
    })
  };
}
function encodeString(value) {
  const hexValue = stringToHex(value);
  const partsLength = Math.ceil(size2(hexValue) / 32);
  const parts = [];
  for (let i = 0;i < partsLength; i++) {
    parts.push(padHex(slice(hexValue, i * 32, (i + 1) * 32), {
      dir: "right"
    }));
  }
  return {
    dynamic: true,
    encoded: concatHex([
      padHex(numberToHex(size2(hexValue), { size: 32 })),
      ...parts
    ])
  };
}
function encodeTuple(value, { param }) {
  let dynamic = false;
  const preparedParams = [];
  for (let i = 0;i < param.components.length; i++) {
    const param_ = param.components[i];
    const index2 = Array.isArray(value) ? i : param_.name;
    const preparedParam = prepareParam({
      param: param_,
      value: value[index2]
    });
    preparedParams.push(preparedParam);
    if (preparedParam.dynamic)
      dynamic = true;
  }
  return {
    dynamic,
    encoded: dynamic ? encodeParams(preparedParams) : concatHex(preparedParams.map(({ encoded }) => encoded))
  };
}
function getArrayComponents(type) {
  const matches = type.match(/^(.*)\[(\d+)?\]$/);
  return matches ? [matches[2] ? Number(matches[2]) : null, matches[1]] : undefined;
}
function isDynamicType(param) {
  const { type } = param;
  if (type === "string")
    return true;
  if (type === "bytes")
    return true;
  if (type.endsWith("[]"))
    return true;
  if (type === "tuple")
    return param.components.some(isDynamicType);
  const arrayComponents = getArrayComponents(type);
  if (arrayComponents)
    return isDynamicType({ ...param, type: arrayComponents[1] });
  return false;
}
var init_encodeAbiParameters = __esm(() => {
  init_abi();
  init_address();
  init_base();
  init_encoding();
  init_isAddress();
  init_pad();
  init_size();
  init_slice();
  init_toHex();
  init_regex2();
});

// node_modules/viem/_esm/utils/abi/decodeAbiParameters.js
function decodeAbiParameters(params, data) {
  const bytes = typeof data === "string" ? hexToBytes(data) : data;
  const cursor = createCursor(bytes);
  if (size2(bytes) === 0 && params.length > 0)
    throw new AbiDecodingZeroDataError;
  if (size2(data) && size2(data) < 32)
    throw new AbiDecodingDataSizeTooSmallError({
      data: typeof data === "string" ? data : bytesToHex(data),
      params,
      size: size2(data)
    });
  let consumed = 0;
  const values = [];
  for (let i = 0;i < params.length; ++i) {
    const param = params[i];
    if (consumed < bytes.length)
      cursor.setPosition(consumed);
    const [data2, consumed_] = decodeParameter(cursor, param, {
      staticPosition: 0
    });
    consumed += consumed_;
    values.push(data2);
  }
  return values;
}
function decodeParameter(cursor, param, { staticPosition }) {
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents) {
    const [length, type] = arrayComponents;
    return decodeArray(cursor, { ...param, type }, { length, staticPosition });
  }
  if (param.type === "tuple")
    return decodeTuple(cursor, param, { staticPosition });
  if (param.type === "address")
    return decodeAddress(cursor);
  if (param.type === "bool")
    return decodeBool(cursor);
  if (param.type.startsWith("bytes"))
    return decodeBytes(cursor, param, { staticPosition });
  if (param.type.startsWith("uint") || param.type.startsWith("int"))
    return decodeNumber(cursor, param);
  if (param.type === "string")
    return decodeString(cursor, { staticPosition });
  throw new InvalidAbiDecodingTypeError(param.type, {
    docsPath: "/docs/contract/decodeAbiParameters"
  });
}
function decodeAddress(cursor) {
  const value = cursor.readBytes(32);
  return [checksumAddress(bytesToHex(sliceBytes(value, -20))), 32];
}
function decodeArray(cursor, param, { length, staticPosition }) {
  if (length === null) {
    const offset = bytesToNumber(cursor.readBytes(sizeOfOffset));
    const start = staticPosition + offset;
    const startOfData = start + sizeOfLength;
    cursor.setPosition(start);
    const length2 = bytesToNumber(cursor.readBytes(sizeOfLength));
    const dynamicChild = hasDynamicChild(param);
    let consumed2 = 0;
    const value2 = [];
    for (let i = 0;i < length2; ++i) {
      cursor.setPosition(startOfData + (dynamicChild ? i * 32 : consumed2));
      const [data, consumed_] = decodeParameter(cursor, param, {
        staticPosition: startOfData
      });
      consumed2 += consumed_;
      value2.push(data);
      if (consumed_ === 0) {
        cursor.assertReadLimit();
        cursor._touch();
      }
    }
    cursor.setPosition(staticPosition + 32);
    return [value2, 32];
  }
  if (hasDynamicChild(param)) {
    const offset = bytesToNumber(cursor.readBytes(sizeOfOffset));
    const start = staticPosition + offset;
    const value2 = [];
    for (let i = 0;i < length; ++i) {
      cursor.setPosition(start + i * 32);
      const [data] = decodeParameter(cursor, param, {
        staticPosition: start
      });
      value2.push(data);
    }
    cursor.setPosition(staticPosition + 32);
    return [value2, 32];
  }
  let consumed = 0;
  const value = [];
  for (let i = 0;i < length; ++i) {
    const [data, consumed_] = decodeParameter(cursor, param, {
      staticPosition: staticPosition + consumed
    });
    consumed += consumed_;
    value.push(data);
    if (consumed_ === 0) {
      cursor.assertReadLimit();
      cursor._touch();
    }
  }
  return [value, consumed];
}
function decodeBool(cursor) {
  return [bytesToBool(cursor.readBytes(32), { size: 32 }), 32];
}
function decodeBytes(cursor, param, { staticPosition }) {
  const [_, size3] = param.type.split("bytes");
  if (!size3) {
    const offset = bytesToNumber(cursor.readBytes(32));
    cursor.setPosition(staticPosition + offset);
    const length = bytesToNumber(cursor.readBytes(32));
    if (length === 0) {
      cursor.setPosition(staticPosition + 32);
      return ["0x", 32];
    }
    const data = cursor.readBytes(length);
    cursor.setPosition(staticPosition + 32);
    return [bytesToHex(data), 32];
  }
  const value = bytesToHex(cursor.readBytes(Number.parseInt(size3, 10), 32));
  return [value, 32];
}
function decodeNumber(cursor, param) {
  const signed = param.type.startsWith("int");
  const size3 = Number.parseInt(param.type.split("int")[1] || "256", 10);
  const value = cursor.readBytes(32);
  return [
    size3 > 48 ? bytesToBigInt(value, { signed }) : bytesToNumber(value, { signed }),
    32
  ];
}
function decodeTuple(cursor, param, { staticPosition }) {
  const hasUnnamedChild = param.components.length === 0 || param.components.some(({ name }) => !name);
  const value = hasUnnamedChild ? [] : {};
  let consumed = 0;
  if (hasDynamicChild(param)) {
    const offset = bytesToNumber(cursor.readBytes(sizeOfOffset));
    const start = staticPosition + offset;
    for (let i = 0;i < param.components.length; ++i) {
      const component = param.components[i];
      cursor.setPosition(start + consumed);
      const [data, consumed_] = decodeParameter(cursor, component, {
        staticPosition: start
      });
      consumed += consumed_;
      value[hasUnnamedChild ? i : component?.name] = data;
    }
    cursor.setPosition(staticPosition + 32);
    return [value, 32];
  }
  for (let i = 0;i < param.components.length; ++i) {
    const component = param.components[i];
    const [data, consumed_] = decodeParameter(cursor, component, {
      staticPosition
    });
    value[hasUnnamedChild ? i : component?.name] = data;
    consumed += consumed_;
  }
  return [value, consumed];
}
function decodeString(cursor, { staticPosition }) {
  const offset = bytesToNumber(cursor.readBytes(32));
  const start = staticPosition + offset;
  cursor.setPosition(start);
  const length = bytesToNumber(cursor.readBytes(32));
  if (length === 0) {
    cursor.setPosition(staticPosition + 32);
    return ["", 32];
  }
  const data = cursor.readBytes(length, 32);
  const value = bytesToString(data);
  cursor.setPosition(staticPosition + 32);
  return [value, 32];
}
function hasDynamicChild(param) {
  const { type } = param;
  if (type === "string")
    return true;
  if (type === "bytes")
    return true;
  if (type.endsWith("[]"))
    return true;
  if (type === "tuple")
    return param.components?.some(hasDynamicChild);
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents && hasDynamicChild({ ...param, type: arrayComponents[1] }))
    return true;
  return false;
}
var sizeOfLength = 32, sizeOfOffset = 32;
var init_decodeAbiParameters = __esm(() => {
  init_abi();
  init_getAddress();
  init_cursor2();
  init_size();
  init_slice();
  init_fromBytes();
  init_toBytes();
  init_toHex();
  init_encodeAbiParameters();
});

// node_modules/viem/_esm/utils/hash/toFunctionSelector.js
var toFunctionSelector3 = (fn) => slice(toSignatureHash(fn), 0, 4);
var init_toFunctionSelector = __esm(() => {
  init_slice();
  init_toSignatureHash();
});

// node_modules/viem/_esm/utils/abi/getAbiItem.js
function getAbiItem2(parameters) {
  const { abi, args = [], name } = parameters;
  const isSelector = isHex(name, { strict: false });
  const abiItems = abi.filter((abiItem) => {
    if (isSelector) {
      if (abiItem.type === "function")
        return toFunctionSelector3(abiItem) === name;
      if (abiItem.type === "event")
        return toEventSelector(abiItem) === name;
      return false;
    }
    return "name" in abiItem && abiItem.name === name;
  });
  if (abiItems.length === 0)
    return;
  if (abiItems.length === 1)
    return abiItems[0];
  let matchedAbiItem;
  for (const abiItem of abiItems) {
    if (!("inputs" in abiItem))
      continue;
    if (!args || args.length === 0) {
      if (!abiItem.inputs || abiItem.inputs.length === 0)
        return abiItem;
      continue;
    }
    if (!abiItem.inputs)
      continue;
    if (abiItem.inputs.length === 0)
      continue;
    if (abiItem.inputs.length !== args.length)
      continue;
    const matched = args.every((arg, index2) => {
      const abiParameter = "inputs" in abiItem && abiItem.inputs[index2];
      if (!abiParameter)
        return false;
      return isArgOfType(arg, abiParameter);
    });
    if (matched) {
      if (matchedAbiItem && "inputs" in matchedAbiItem && matchedAbiItem.inputs) {
        const ambiguousTypes = getAmbiguousTypes(abiItem.inputs, matchedAbiItem.inputs, args);
        if (ambiguousTypes)
          throw new AbiItemAmbiguityError({
            abiItem,
            type: ambiguousTypes[0]
          }, {
            abiItem: matchedAbiItem,
            type: ambiguousTypes[1]
          });
      }
      matchedAbiItem = abiItem;
    }
  }
  if (matchedAbiItem)
    return matchedAbiItem;
  return abiItems[0];
}
function isArgOfType(arg, abiParameter) {
  const argType = typeof arg;
  const abiParameterType = abiParameter.type;
  switch (abiParameterType) {
    case "address":
      return isAddress(arg, { strict: false });
    case "bool":
      return argType === "boolean";
    case "function":
      return argType === "string";
    case "string":
      return argType === "string";
    default: {
      if (abiParameterType === "tuple" && "components" in abiParameter)
        return Object.values(abiParameter.components).every((component, index2) => {
          return argType === "object" && isArgOfType(Object.values(arg)[index2], component);
        });
      if (/^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(abiParameterType))
        return argType === "number" || argType === "bigint";
      if (/^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])?$/.test(abiParameterType))
        return argType === "string" || arg instanceof Uint8Array;
      if (/[a-z]+[1-9]{0,3}(\[[0-9]{0,}\])+$/.test(abiParameterType)) {
        return Array.isArray(arg) && arg.every((x) => isArgOfType(x, {
          ...abiParameter,
          type: abiParameterType.replace(/(\[[0-9]{0,}\])$/, "")
        }));
      }
      return false;
    }
  }
}
function getAmbiguousTypes(sourceParameters, targetParameters, args) {
  for (const parameterIndex in sourceParameters) {
    const sourceParameter = sourceParameters[parameterIndex];
    const targetParameter = targetParameters[parameterIndex];
    if (sourceParameter.type === "tuple" && targetParameter.type === "tuple" && "components" in sourceParameter && "components" in targetParameter)
      return getAmbiguousTypes(sourceParameter.components, targetParameter.components, args[parameterIndex]);
    const types = [sourceParameter.type, targetParameter.type];
    const ambiguous = (() => {
      if (types.includes("address") && types.includes("bytes20"))
        return true;
      if (types.includes("address") && types.includes("string"))
        return isAddress(args[parameterIndex], { strict: false });
      if (types.includes("address") && types.includes("bytes"))
        return isAddress(args[parameterIndex], { strict: false });
      return false;
    })();
    if (ambiguous)
      return types;
  }
  return;
}
var init_getAbiItem = __esm(() => {
  init_abi();
  init_isAddress();
  init_toEventSelector();
  init_toFunctionSelector();
});

// node_modules/viem/_esm/utils/abi/decodeFunctionResult.js
function decodeFunctionResult2(parameters) {
  const { abi, args, functionName, data } = parameters;
  let abiItem = abi[0];
  if (functionName) {
    const item = getAbiItem2({ abi, args, name: functionName });
    if (!item)
      throw new AbiFunctionNotFoundError(functionName, { docsPath: docsPath2 });
    abiItem = item;
  }
  if (abiItem.type !== "function")
    throw new AbiFunctionNotFoundError(undefined, { docsPath: docsPath2 });
  if (!abiItem.outputs)
    throw new AbiFunctionOutputsNotFoundError(abiItem.name, { docsPath: docsPath2 });
  const values = decodeAbiParameters(abiItem.outputs, data);
  if (values && values.length > 1)
    return values;
  if (values && values.length === 1)
    return values[0];
  return;
}
var docsPath2 = "/docs/contract/decodeFunctionResult";
var init_decodeFunctionResult = __esm(() => {
  init_abi();
  init_decodeAbiParameters();
  init_getAbiItem();
});

// node_modules/viem/_esm/utils/abi/prepareEncodeFunctionData.js
function prepareEncodeFunctionData2(parameters) {
  const { abi, args, functionName } = parameters;
  let abiItem = abi[0];
  if (functionName) {
    const item = getAbiItem2({
      abi,
      args,
      name: functionName
    });
    if (!item)
      throw new AbiFunctionNotFoundError(functionName, { docsPath: docsPath3 });
    abiItem = item;
  }
  if (abiItem.type !== "function")
    throw new AbiFunctionNotFoundError(undefined, { docsPath: docsPath3 });
  return {
    abi: [abiItem],
    functionName: toFunctionSelector3(formatAbiItem2(abiItem))
  };
}
var docsPath3 = "/docs/contract/encodeFunctionData";
var init_prepareEncodeFunctionData = __esm(() => {
  init_abi();
  init_toFunctionSelector();
  init_formatAbiItem2();
  init_getAbiItem();
});

// node_modules/viem/_esm/utils/abi/encodeFunctionData.js
function encodeFunctionData2(parameters) {
  const { args } = parameters;
  const { abi, functionName } = (() => {
    if (parameters.abi.length === 1 && parameters.functionName?.startsWith("0x"))
      return parameters;
    return prepareEncodeFunctionData2(parameters);
  })();
  const abiItem = abi[0];
  const signature = functionName;
  const data = "inputs" in abiItem && abiItem.inputs ? encodeAbiParameters(abiItem.inputs, args ?? []) : undefined;
  return concatHex([signature, data ?? "0x"]);
}
var init_encodeFunctionData = __esm(() => {
  init_encodeAbiParameters();
  init_prepareEncodeFunctionData();
});

// node_modules/viem/_esm/constants/solidity.js
var panicReasons, solidityError, solidityPanic;
var init_solidity = __esm(() => {
  panicReasons = {
    1: "An `assert` condition failed.",
    17: "Arithmetic operation resulted in underflow or overflow.",
    18: "Division or modulo by zero (e.g. `5 / 0` or `23 % 0`).",
    33: "Attempted to convert to an invalid type.",
    34: "Attempted to access a storage byte array that is incorrectly encoded.",
    49: "Performed `.pop()` on an empty array",
    50: "Array index is out of bounds.",
    65: "Allocated too much memory or created an array which is too large.",
    81: "Attempted to call a zero-initialized variable of internal function type."
  };
  solidityError = {
    inputs: [
      {
        name: "message",
        type: "string"
      }
    ],
    name: "Error",
    type: "error"
  };
  solidityPanic = {
    inputs: [
      {
        name: "reason",
        type: "uint256"
      }
    ],
    name: "Panic",
    type: "error"
  };
});

// node_modules/viem/_esm/utils/abi/decodeErrorResult.js
function decodeErrorResult2(parameters) {
  const { abi, data, cause } = parameters;
  const signature = slice(data, 0, 4);
  if (signature === "0x")
    throw new AbiDecodingZeroDataError({ cause });
  const abi_ = [...abi || [], solidityError, solidityPanic];
  const abiItem = abi_.find((x) => x.type === "error" && signature === toFunctionSelector3(formatAbiItem2(x)));
  if (!abiItem)
    throw new AbiErrorSignatureNotFoundError(signature, {
      docsPath: "/docs/contract/decodeErrorResult",
      cause
    });
  return {
    abiItem,
    args: "inputs" in abiItem && abiItem.inputs && abiItem.inputs.length > 0 ? decodeAbiParameters(abiItem.inputs, slice(data, 4)) : undefined,
    errorName: abiItem.name
  };
}
var init_decodeErrorResult = __esm(() => {
  init_solidity();
  init_abi();
  init_slice();
  init_toFunctionSelector();
  init_decodeAbiParameters();
  init_formatAbiItem2();
});

// node_modules/viem/_esm/utils/abi/formatAbiItemWithArgs.js
function formatAbiItemWithArgs({ abiItem, args, includeFunctionName = true, includeName = false }) {
  if (!("name" in abiItem))
    return;
  if (!("inputs" in abiItem))
    return;
  if (!abiItem.inputs)
    return;
  return `${includeFunctionName ? abiItem.name : ""}(${abiItem.inputs.map((input, i) => `${includeName && input.name ? `${input.name}: ` : ""}${typeof args[i] === "object" ? stringify(args[i]) : args[i]}`).join(", ")})`;
}
var init_formatAbiItemWithArgs = () => {};

// node_modules/viem/_esm/utils/unit/Value.js
function format(value, decimals = 0) {
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new InvalidDecimalsError({ decimals });
  let display = value.toString();
  const negative = display.startsWith("-");
  if (negative)
    display = display.slice(1);
  display = display.padStart(decimals, "0");
  let [integer, fraction] = [
    display.slice(0, display.length - decimals),
    display.slice(display.length - decimals)
  ];
  fraction = fraction.replace(/(0+)$/, "");
  return `${negative ? "-" : ""}${integer || "0"}${fraction ? `.${fraction}` : ""}`;
}
function formatEther2(wei, unit = "wei") {
  return format(wei, exponents.ether - exponents[unit]);
}
function formatGwei2(wei, unit = "wei") {
  return format(wei, exponents.gwei - exponents[unit]);
}
var exponents, InvalidDecimalsError;
var init_Value = __esm(() => {
  exponents = {
    wei: 0,
    gwei: 9,
    szabo: 12,
    finney: 15,
    ether: 18
  };
  InvalidDecimalsError = class InvalidDecimalsError extends Error {
    constructor({ decimals }) {
      super(`\`decimals\` must be a non-negative integer. Got \`${decimals}\`.`);
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "Value.InvalidDecimalsError"
      });
    }
  };
});

// node_modules/viem/_esm/utils/unit/formatEther.js
function formatEther3(wei, unit = "wei") {
  return formatEther2(wei, unit);
}
var init_formatEther = __esm(() => {
  init_Value();
});

// node_modules/viem/_esm/utils/unit/formatGwei.js
function formatGwei3(wei, unit = "wei") {
  return formatGwei2(wei, unit);
}
var init_formatGwei = __esm(() => {
  init_Value();
});

// node_modules/viem/_esm/errors/stateOverride.js
function prettyStateMapping(stateMapping) {
  return stateMapping.reduce((pretty, { slot, value }) => {
    return `${pretty}        ${slot}: ${value}
`;
  }, "");
}
function prettyStateOverride(stateOverride) {
  return stateOverride.reduce((pretty, { address, ...state }) => {
    let val = `${pretty}    ${address}:
`;
    if (state.nonce)
      val += `      nonce: ${state.nonce}
`;
    if (state.balance)
      val += `      balance: ${state.balance}
`;
    if (state.code)
      val += `      code: ${state.code}
`;
    if (state.state) {
      val += `      state:
`;
      val += prettyStateMapping(state.state);
    }
    if (state.stateDiff) {
      val += `      stateDiff:
`;
      val += prettyStateMapping(state.stateDiff);
    }
    return val;
  }, `  State Override:
`).slice(0, -1);
}
var AccountStateConflictError2, StateAssignmentConflictError2;
var init_stateOverride = __esm(() => {
  init_base();
  AccountStateConflictError2 = class AccountStateConflictError2 extends BaseError3 {
    constructor({ address }) {
      super(`State for account "${address}" is set multiple times.`, {
        name: "AccountStateConflictError"
      });
    }
  };
  StateAssignmentConflictError2 = class StateAssignmentConflictError2 extends BaseError3 {
    constructor() {
      super("state and stateDiff are set on the same account.", {
        name: "StateAssignmentConflictError"
      });
    }
  };
});

// node_modules/viem/_esm/errors/transaction.js
function prettyPrint(args) {
  const entries = Object.entries(args).map(([key, value]) => {
    if (value === undefined || value === false)
      return null;
    return [key, value];
  }).filter(Boolean);
  const maxLength = entries.reduce((acc, [key]) => Math.max(acc, key.length), 0);
  return entries.map(([key, value]) => `  ${`${key}:`.padEnd(maxLength + 1)}  ${value}`).join(`
`);
}
var TransactionNotFoundError2, TransactionReceiptNotFoundError2, WaitForTransactionReceiptTimeoutError2;
var init_transaction = __esm(() => {
  init_base();
  TransactionNotFoundError2 = class TransactionNotFoundError2 extends BaseError3 {
    constructor({ blockHash, blockNumber, blockTag, hash: hash2, index: index2 }) {
      let identifier = "Transaction";
      if (blockTag && index2 !== undefined)
        identifier = `Transaction at block time "${blockTag}" at index "${index2}"`;
      if (blockHash && index2 !== undefined)
        identifier = `Transaction at block hash "${blockHash}" at index "${index2}"`;
      if (blockNumber && index2 !== undefined)
        identifier = `Transaction at block number "${blockNumber}" at index "${index2}"`;
      if (hash2)
        identifier = `Transaction with hash "${hash2}"`;
      super(`${identifier} could not be found.`, {
        name: "TransactionNotFoundError"
      });
    }
  };
  TransactionReceiptNotFoundError2 = class TransactionReceiptNotFoundError2 extends BaseError3 {
    constructor({ hash: hash2 }) {
      super(`Transaction receipt with hash "${hash2}" could not be found. The Transaction may not be processed on a block yet.`, {
        name: "TransactionReceiptNotFoundError"
      });
    }
  };
  WaitForTransactionReceiptTimeoutError2 = class WaitForTransactionReceiptTimeoutError2 extends BaseError3 {
    constructor({ hash: hash2 }) {
      super(`Timed out while waiting for transaction with hash "${hash2}" to be confirmed.`, { name: "WaitForTransactionReceiptTimeoutError" });
    }
  };
});

// node_modules/viem/_esm/errors/contract.js
var CallExecutionError2, ContractFunctionExecutionError2, ContractFunctionRevertedError2, ContractFunctionZeroDataError2, CounterfactualDeploymentFailedError2, RawContractError2;
var init_contract = __esm(() => {
  init_solidity();
  init_decodeErrorResult();
  init_formatAbiItem2();
  init_formatAbiItemWithArgs();
  init_getAbiItem();
  init_formatEther();
  init_formatGwei();
  init_abi();
  init_base();
  init_stateOverride();
  init_transaction();
  CallExecutionError2 = class CallExecutionError2 extends BaseError3 {
    constructor(cause, { account: account_, docsPath: docsPath4, chain, data, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce, to, value, stateOverride }) {
      const account = account_ ? parseAccount(account_) : undefined;
      let prettyArgs = prettyPrint({
        from: account?.address,
        to,
        value: typeof value !== "undefined" && `${formatEther3(value)} ${chain?.nativeCurrency?.symbol || "ETH"}`,
        data,
        gas,
        gasPrice: typeof gasPrice !== "undefined" && `${formatGwei3(gasPrice)} gwei`,
        maxFeePerGas: typeof maxFeePerGas !== "undefined" && `${formatGwei3(maxFeePerGas)} gwei`,
        maxPriorityFeePerGas: typeof maxPriorityFeePerGas !== "undefined" && `${formatGwei3(maxPriorityFeePerGas)} gwei`,
        nonce
      });
      if (stateOverride) {
        prettyArgs += `
${prettyStateOverride(stateOverride)}`;
      }
      super(cause.shortMessage, {
        cause,
        docsPath: docsPath4,
        metaMessages: [
          ...cause.metaMessages ? [...cause.metaMessages, " "] : [],
          "Raw Call Arguments:",
          prettyArgs
        ].filter(Boolean),
        name: "CallExecutionError"
      });
      Object.defineProperty(this, "cause", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.cause = cause;
    }
  };
  ContractFunctionExecutionError2 = class ContractFunctionExecutionError2 extends BaseError3 {
    constructor(cause, { abi, args, contractAddress, docsPath: docsPath4, functionName, sender }) {
      const abiItem = getAbiItem2({ abi, args, name: functionName });
      const formattedArgs = abiItem ? formatAbiItemWithArgs({
        abiItem,
        args,
        includeFunctionName: false,
        includeName: false
      }) : undefined;
      const functionWithParams = abiItem ? formatAbiItem2(abiItem, { includeName: true }) : undefined;
      const prettyArgs = prettyPrint({
        address: contractAddress && getContractAddress(contractAddress),
        function: functionWithParams,
        args: formattedArgs && formattedArgs !== "()" && `${[...Array(functionName?.length ?? 0).keys()].map(() => " ").join("")}${formattedArgs}`,
        sender
      });
      super(cause.shortMessage || `An unknown error occurred while executing the contract function "${functionName}".`, {
        cause,
        docsPath: docsPath4,
        metaMessages: [
          ...cause.metaMessages ? [...cause.metaMessages, " "] : [],
          prettyArgs && "Contract Call:",
          prettyArgs
        ].filter(Boolean),
        name: "ContractFunctionExecutionError"
      });
      Object.defineProperty(this, "abi", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "args", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "cause", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "contractAddress", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "formattedArgs", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "functionName", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "sender", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.abi = abi;
      this.args = args;
      this.cause = cause;
      this.contractAddress = contractAddress;
      this.functionName = functionName;
      this.sender = sender;
    }
  };
  ContractFunctionRevertedError2 = class ContractFunctionRevertedError2 extends BaseError3 {
    constructor({ abi, data, functionName, message, cause: error }) {
      let cause;
      let decodedData;
      let metaMessages;
      let reason;
      if (data && data !== "0x") {
        try {
          decodedData = decodeErrorResult2({ abi, data, cause: error });
          const { abiItem, errorName, args: errorArgs } = decodedData;
          if (errorName === "Error") {
            reason = errorArgs[0];
          } else if (errorName === "Panic") {
            const [firstArg] = errorArgs;
            reason = panicReasons[firstArg];
          } else {
            const errorWithParams = abiItem ? formatAbiItem2(abiItem, { includeName: true }) : undefined;
            const formattedArgs = abiItem && errorArgs ? formatAbiItemWithArgs({
              abiItem,
              args: errorArgs,
              includeFunctionName: false,
              includeName: false
            }) : undefined;
            metaMessages = [
              errorWithParams ? `Error: ${errorWithParams}` : "",
              formattedArgs && formattedArgs !== "()" ? `       ${[...Array(errorName?.length ?? 0).keys()].map(() => " ").join("")}${formattedArgs}` : ""
            ];
          }
        } catch (err) {
          cause = err;
        }
      } else if (message)
        reason = message;
      let signature;
      if (cause instanceof AbiErrorSignatureNotFoundError) {
        signature = cause.signature;
        metaMessages = [
          `Unable to decode signature "${signature}" as it was not found on the provided ABI.`,
          "Make sure you are using the correct ABI and that the error exists on it.",
          `You can look up the decoded signature here: https://4byte.sourcify.dev/?q=${signature}.`
        ];
      }
      super(reason && reason !== "execution reverted" || signature ? [
        `The contract function "${functionName}" reverted with the following ${signature ? "signature" : "reason"}:`,
        reason || signature
      ].join(`
`) : `The contract function "${functionName}" reverted.`, {
        cause: cause ?? error,
        metaMessages,
        name: "ContractFunctionRevertedError"
      });
      Object.defineProperty(this, "data", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "raw", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "reason", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "signature", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.data = decodedData;
      this.raw = data;
      this.reason = reason;
      this.signature = signature;
    }
  };
  ContractFunctionZeroDataError2 = class ContractFunctionZeroDataError2 extends BaseError3 {
    constructor({ functionName, cause }) {
      super(`The contract function "${functionName}" returned no data ("0x").`, {
        metaMessages: [
          "This could be due to any of the following:",
          `  - The contract does not have the function "${functionName}",`,
          "  - The parameters passed to the contract function may be invalid, or",
          "  - The address is not a contract."
        ],
        name: "ContractFunctionZeroDataError",
        cause
      });
    }
  };
  CounterfactualDeploymentFailedError2 = class CounterfactualDeploymentFailedError2 extends BaseError3 {
    constructor({ factory }) {
      super(`Deployment for counterfactual contract call failed${factory ? ` for factory "${factory}".` : ""}`, {
        metaMessages: [
          "Please ensure:",
          "- The `factory` is a valid contract deployment factory (ie. Create2 Factory, ERC-4337 Factory, etc).",
          "- The `factoryData` is a valid encoded function call for contract deployment function on the factory."
        ],
        name: "CounterfactualDeploymentFailedError"
      });
    }
  };
  RawContractError2 = class RawContractError2 extends BaseError3 {
    constructor({ data, message }) {
      super(message || "", { name: "RawContractError" });
      Object.defineProperty(this, "code", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 3
      });
      Object.defineProperty(this, "data", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      this.data = data;
    }
  };
});

// node_modules/ox/_esm/core/version.js
var version3 = "0.1.1";

// node_modules/ox/_esm/core/internal/errors.js
function getVersion() {
  return version3;
}
var init_errors2 = () => {};

// node_modules/ox/_esm/core/Errors.js
function walk2(err, fn) {
  if (fn?.(err))
    return err;
  if (err && typeof err === "object" && "cause" in err && err.cause)
    return walk2(err.cause, fn);
  return fn ? null : err;
}
var BaseError5;
var init_Errors = __esm(() => {
  init_errors2();
  BaseError5 = class BaseError5 extends Error {
    static setStaticOptions(options) {
      BaseError5.prototype.docsOrigin = options.docsOrigin;
      BaseError5.prototype.showVersion = options.showVersion;
      BaseError5.prototype.version = options.version;
    }
    constructor(shortMessage, options = {}) {
      const details = (() => {
        if (options.cause instanceof BaseError5) {
          if (options.cause.details)
            return options.cause.details;
          if (options.cause.shortMessage)
            return options.cause.shortMessage;
        }
        if (options.cause && "details" in options.cause && typeof options.cause.details === "string")
          return options.cause.details;
        if (options.cause?.message)
          return options.cause.message;
        return options.details;
      })();
      const docsPath4 = (() => {
        if (options.cause instanceof BaseError5)
          return options.cause.docsPath || options.docsPath;
        return options.docsPath;
      })();
      const docsBaseUrl = options.docsOrigin ?? BaseError5.prototype.docsOrigin;
      const docs = `${docsBaseUrl}${docsPath4 ?? ""}`;
      const showVersion = Boolean(options.version ?? BaseError5.prototype.showVersion);
      const version4 = options.version ?? BaseError5.prototype.version;
      const message = [
        shortMessage || "An error occurred.",
        ...options.metaMessages ? ["", ...options.metaMessages] : [],
        ...details || docsPath4 || showVersion ? [
          "",
          details ? `Details: ${details}` : undefined,
          docsPath4 ? `See: ${docs}` : undefined,
          showVersion ? `Version: ${version4}` : undefined
        ] : []
      ].filter((x) => typeof x === "string").join(`
`);
      super(message, options.cause ? { cause: options.cause } : undefined);
      Object.defineProperty(this, "details", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "docs", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "docsOrigin", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "docsPath", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "shortMessage", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "showVersion", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "version", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "cause", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined
      });
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "BaseError"
      });
      this.cause = options.cause;
      this.details = details;
      this.docs = docs;
      this.docsOrigin = docsBaseUrl;
      this.docsPath = docsPath4;
      this.shortMessage = shortMessage;
      this.showVersion = showVersion;
      this.version = version4;
    }
    walk(fn) {
      return walk2(this, fn);
    }
  };
  Object.defineProperty(BaseError5, "defaultStaticOptions", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: {
      docsOrigin: "https://oxlib.sh",
      showVersion: false,
      version: `ox@${getVersion()}`
    }
  });
  (() => {
    BaseError5.setStaticOptions(BaseError5.defaultStaticOptions);
  })();
});

// node_modules/ox/_esm/core/internal/hex.js
function pad3(hex_, options = {}) {
  const { dir, size: size5 = 32 } = options;
  if (size5 === 0)
    return hex_;
  const hex = hex_.replace("0x", "");
  if (hex.length > size5 * 2)
    throw new SizeExceedsPaddingSizeError3({
      size: Math.ceil(hex.length / 2),
      targetSize: size5,
      type: "Hex"
    });
  return `0x${hex[dir === "right" ? "padEnd" : "padStart"](size5 * 2, "0")}`;
}
var init_hex = __esm(() => {
  init_Hex();
});

// node_modules/ox/_esm/core/Hex.js
function fromNumber(value, options = {}) {
  const { signed, size: size5 } = options;
  const value_ = BigInt(value);
  let maxValue;
  if (size5) {
    if (signed)
      maxValue = (1n << BigInt(size5) * 8n - 1n) - 1n;
    else
      maxValue = 2n ** (BigInt(size5) * 8n) - 1n;
  } else if (typeof value === "number") {
    maxValue = BigInt(Number.MAX_SAFE_INTEGER);
  }
  const minValue = typeof maxValue === "bigint" && signed ? -maxValue - 1n : 0;
  if (maxValue && value_ > maxValue || value_ < minValue) {
    const suffix = typeof value === "bigint" ? "n" : "";
    throw new IntegerOutOfRangeError3({
      max: maxValue ? `${maxValue}${suffix}` : undefined,
      min: `${minValue}${suffix}`,
      signed,
      size: size5,
      value: `${value}${suffix}`
    });
  }
  const stringValue = (signed && value_ < 0 ? BigInt.asUintN(size5 * 8, BigInt(value_)) : value_).toString(16);
  const hex = `0x${stringValue}`;
  if (size5)
    return padLeft(hex, size5);
  return hex;
}
function padLeft(value, size5) {
  return pad3(value, { dir: "left", size: size5 });
}
var IntegerOutOfRangeError3, SizeExceedsPaddingSizeError3;
var init_Hex = __esm(() => {
  init_Errors();
  init_hex();
  IntegerOutOfRangeError3 = class IntegerOutOfRangeError3 extends BaseError5 {
    constructor({ max, min, signed, size: size5, value }) {
      super(`Number \`${value}\` is not in safe${size5 ? ` ${size5 * 8}-bit` : ""}${signed ? " signed" : " unsigned"} integer range ${max ? `(\`${min}\` to \`${max}\`)` : `(above \`${min}\`)`}`);
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "Hex.IntegerOutOfRangeError"
      });
    }
  };
  SizeExceedsPaddingSizeError3 = class SizeExceedsPaddingSizeError3 extends BaseError5 {
    constructor({ size: size5, targetSize, type }) {
      super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (\`${size5}\`) exceeds padding size (\`${targetSize}\`).`);
      Object.defineProperty(this, "name", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "Hex.SizeExceedsPaddingSizeError"
      });
    }
  };
});

// node_modules/ox/_esm/core/Withdrawal.js
function toRpc(withdrawal) {
  return {
    address: withdrawal.address,
    amount: fromNumber(withdrawal.amount),
    index: fromNumber(withdrawal.index),
    validatorIndex: fromNumber(withdrawal.validatorIndex)
  };
}
var init_Withdrawal = __esm(() => {
  init_Hex();
});

// node_modules/ox/_esm/core/BlockOverrides.js
function toRpc2(blockOverrides) {
  return {
    ...typeof blockOverrides.baseFeePerGas === "bigint" && {
      baseFeePerGas: fromNumber(blockOverrides.baseFeePerGas)
    },
    ...typeof blockOverrides.blobBaseFee === "bigint" && {
      blobBaseFee: fromNumber(blockOverrides.blobBaseFee)
    },
    ...typeof blockOverrides.feeRecipient === "string" && {
      feeRecipient: blockOverrides.feeRecipient
    },
    ...typeof blockOverrides.gasLimit === "bigint" && {
      gasLimit: fromNumber(blockOverrides.gasLimit)
    },
    ...typeof blockOverrides.number === "bigint" && {
      number: fromNumber(blockOverrides.number)
    },
    ...typeof blockOverrides.prevRandao === "bigint" && {
      prevRandao: fromNumber(blockOverrides.prevRandao)
    },
    ...typeof blockOverrides.time === "bigint" && {
      time: fromNumber(blockOverrides.time)
    },
    ...blockOverrides.withdrawals && {
      withdrawals: blockOverrides.withdrawals.map(toRpc)
    }
  };
}
var init_BlockOverrides = __esm(() => {
  init_Hex();
  init_Withdrawal();
});

// node_modules/viem/_esm/constants/abis.js
var multicall3Abi2, batchGatewayAbi, universalResolverErrors, universalResolverResolveAbi, universalResolverReverseAbi;
var init_abis = __esm(() => {
  multicall3Abi2 = [
    {
      inputs: [
        {
          components: [
            {
              name: "target",
              type: "address"
            },
            {
              name: "allowFailure",
              type: "bool"
            },
            {
              name: "callData",
              type: "bytes"
            }
          ],
          name: "calls",
          type: "tuple[]"
        }
      ],
      name: "aggregate3",
      outputs: [
        {
          components: [
            {
              name: "success",
              type: "bool"
            },
            {
              name: "returnData",
              type: "bytes"
            }
          ],
          name: "returnData",
          type: "tuple[]"
        }
      ],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [
        {
          name: "addr",
          type: "address"
        }
      ],
      name: "getEthBalance",
      outputs: [
        {
          name: "balance",
          type: "uint256"
        }
      ],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [],
      name: "getCurrentBlockTimestamp",
      outputs: [
        {
          internalType: "uint256",
          name: "timestamp",
          type: "uint256"
        }
      ],
      stateMutability: "view",
      type: "function"
    }
  ];
  batchGatewayAbi = [
    {
      name: "query",
      type: "function",
      stateMutability: "view",
      inputs: [
        {
          type: "tuple[]",
          name: "queries",
          components: [
            {
              type: "address",
              name: "sender"
            },
            {
              type: "string[]",
              name: "urls"
            },
            {
              type: "bytes",
              name: "data"
            }
          ]
        }
      ],
      outputs: [
        {
          type: "bool[]",
          name: "failures"
        },
        {
          type: "bytes[]",
          name: "responses"
        }
      ]
    },
    {
      name: "HttpError",
      type: "error",
      inputs: [
        {
          type: "uint16",
          name: "status"
        },
        {
          type: "string",
          name: "message"
        }
      ]
    }
  ];
  universalResolverErrors = [
    {
      inputs: [
        {
          name: "dns",
          type: "bytes"
        }
      ],
      name: "DNSDecodingFailed",
      type: "error"
    },
    {
      inputs: [
        {
          name: "ens",
          type: "string"
        }
      ],
      name: "DNSEncodingFailed",
      type: "error"
    },
    {
      inputs: [],
      name: "EmptyAddress",
      type: "error"
    },
    {
      inputs: [
        {
          name: "status",
          type: "uint16"
        },
        {
          name: "message",
          type: "string"
        }
      ],
      name: "HttpError",
      type: "error"
    },
    {
      inputs: [],
      name: "InvalidBatchGatewayResponse",
      type: "error"
    },
    {
      inputs: [
        {
          name: "errorData",
          type: "bytes"
        }
      ],
      name: "ResolverError",
      type: "error"
    },
    {
      inputs: [
        {
          name: "name",
          type: "bytes"
        },
        {
          name: "resolver",
          type: "address"
        }
      ],
      name: "ResolverNotContract",
      type: "error"
    },
    {
      inputs: [
        {
          name: "name",
          type: "bytes"
        }
      ],
      name: "ResolverNotFound",
      type: "error"
    },
    {
      inputs: [
        {
          name: "primary",
          type: "string"
        },
        {
          name: "primaryAddress",
          type: "bytes"
        }
      ],
      name: "ReverseAddressMismatch",
      type: "error"
    },
    {
      inputs: [
        {
          internalType: "bytes4",
          name: "selector",
          type: "bytes4"
        }
      ],
      name: "UnsupportedResolverProfile",
      type: "error"
    }
  ];
  universalResolverResolveAbi = [
    ...universalResolverErrors,
    {
      name: "resolveWithGateways",
      type: "function",
      stateMutability: "view",
      inputs: [
        { name: "name", type: "bytes" },
        { name: "data", type: "bytes" },
        { name: "gateways", type: "string[]" }
      ],
      outputs: [
        { name: "", type: "bytes" },
        { name: "address", type: "address" }
      ]
    }
  ];
  universalResolverReverseAbi = [
    ...universalResolverErrors,
    {
      name: "reverseWithGateways",
      type: "function",
      stateMutability: "view",
      inputs: [
        { type: "bytes", name: "reverseName" },
        { type: "uint256", name: "coinType" },
        { type: "string[]", name: "gateways" }
      ],
      outputs: [
        { type: "string", name: "resolvedName" },
        { type: "address", name: "resolver" },
        { type: "address", name: "reverseResolver" }
      ]
    }
  ];
});

// node_modules/viem/_esm/constants/contract.js
var aggregate3Signature = "0x82ad56cb";

// node_modules/viem/_esm/constants/contracts.js
var deploylessCallViaBytecodeBytecode2 = "0x608060405234801561001057600080fd5b5060405161018e38038061018e83398101604081905261002f91610124565b6000808351602085016000f59050803b61004857600080fd5b6000808351602085016000855af16040513d6000823e81610067573d81fd5b3d81f35b634e487b7160e01b600052604160045260246000fd5b600082601f83011261009257600080fd5b81516001600160401b038111156100ab576100ab61006b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100d9576100d961006b565b6040528181528382016020018510156100f157600080fd5b60005b82811015610110576020818601810151838301820152016100f4565b506000918101602001919091529392505050565b6000806040838503121561013757600080fd5b82516001600160401b0381111561014d57600080fd5b61015985828601610081565b602085015190935090506001600160401b0381111561017757600080fd5b61018385828601610081565b915050925092905056fe", deploylessCallViaFactoryBytecode2 = "0x608060405234801561001057600080fd5b506040516102c03803806102c083398101604081905261002f916101e6565b836001600160a01b03163b6000036100e457600080836001600160a01b03168360405161005c9190610270565b6000604051808303816000865af19150503d8060008114610099576040519150601f19603f3d011682016040523d82523d6000602084013e61009e565b606091505b50915091508115806100b857506001600160a01b0386163b155b156100e1578060405163101bb98d60e01b81526004016100d8919061028c565b60405180910390fd5b50505b6000808451602086016000885af16040513d6000823e81610103573d81fd5b3d81f35b80516001600160a01b038116811461011e57600080fd5b919050565b634e487b7160e01b600052604160045260246000fd5b60005b8381101561015457818101518382015260200161013c565b50506000910152565b600082601f83011261016e57600080fd5b81516001600160401b0381111561018757610187610123565b604051601f8201601f19908116603f011681016001600160401b03811182821017156101b5576101b5610123565b6040528181528382016020018510156101cd57600080fd5b6101de826020830160208701610139565b949350505050565b600080600080608085870312156101fc57600080fd5b61020585610107565b60208601519094506001600160401b0381111561022157600080fd5b61022d8782880161015d565b93505061023c60408601610107565b60608601519092506001600160401b0381111561025857600080fd5b6102648782880161015d565b91505092959194509250565b60008251610282818460208701610139565b9190910192915050565b60208152600082518060208401526102ab816040850160208701610139565b601f01601f1916919091016040019291505056fe", multicall3Bytecode = "0x608060405234801561001057600080fd5b506115b9806100206000396000f3fe6080604052600436106100f35760003560e01c80634d2301cc1161008a578063a8b0574e11610059578063a8b0574e14610325578063bce38bd714610350578063c3077fa914610380578063ee82ac5e146103b2576100f3565b80634d2301cc1461026257806372425d9d1461029f57806382ad56cb146102ca57806386d516e8146102fa576100f3565b80633408e470116100c65780633408e470146101af578063399542e9146101da5780633e64a6961461020c57806342cbb15c14610237576100f3565b80630f28c97d146100f8578063174dea7114610123578063252dba421461015357806327e86d6e14610184575b600080fd5b34801561010457600080fd5b5061010d6103ef565b60405161011a9190610c0a565b60405180910390f35b61013d60048036038101906101389190610c94565b6103f7565b60405161014a9190610e94565b60405180910390f35b61016d60048036038101906101689190610f0c565b610615565b60405161017b92919061101b565b60405180910390f35b34801561019057600080fd5b506101996107ab565b6040516101a69190611064565b60405180910390f35b3480156101bb57600080fd5b506101c46107b7565b6040516101d19190610c0a565b60405180910390f35b6101f460048036038101906101ef91906110ab565b6107bf565b6040516102039392919061110b565b60405180910390f35b34801561021857600080fd5b506102216107e1565b60405161022e9190610c0a565b60405180910390f35b34801561024357600080fd5b5061024c6107e9565b6040516102599190610c0a565b60405180910390f35b34801561026e57600080fd5b50610289600480360381019061028491906111a7565b6107f1565b6040516102969190610c0a565b60405180910390f35b3480156102ab57600080fd5b506102b4610812565b6040516102c19190610c0a565b60405180910390f35b6102e460048036038101906102df919061122a565b61081a565b6040516102f19190610e94565b60405180910390f35b34801561030657600080fd5b5061030f6109e4565b60405161031c9190610c0a565b60405180910390f35b34801561033157600080fd5b5061033a6109ec565b6040516103479190611286565b60405180910390f35b61036a600480360381019061036591906110ab565b6109f4565b6040516103779190610e94565b60405180910390f35b61039a60048036038101906103959190610f0c565b610ba6565b6040516103a99392919061110b565b60405180910390f35b3480156103be57600080fd5b506103d960048036038101906103d491906112cd565b610bca565b6040516103e69190611064565b60405180910390f35b600042905090565b60606000808484905090508067ffffffffffffffff81111561041c5761041b6112fa565b5b60405190808252806020026020018201604052801561045557816020015b610442610bd5565b81526020019060019003908161043a5790505b5092503660005b828110156105c957600085828151811061047957610478611329565b5b6020026020010151905087878381811061049657610495611329565b5b90506020028101906104a89190611367565b925060008360400135905080860195508360000160208101906104cb91906111a7565b73ffffffffffffffffffffffffffffffffffffffff16818580606001906104f2919061138f565b604051610500929190611431565b60006040518083038185875af1925050503d806000811461053d576040519150601f19603f3d011682016040523d82523d6000602084013e610542565b606091505b5083600001846020018290528215151515815250505081516020850135176105bc577f08c379a000000000000000000000000000000000000000000000000000000000600052602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260846000fd5b826001019250505061045c565b5082341461060c576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610603906114a7565b60405180910390fd5b50505092915050565b6000606043915060008484905090508067ffffffffffffffff81111561063e5761063d6112fa565b5b60405190808252806020026020018201604052801561067157816020015b606081526020019060019003908161065c5790505b5091503660005b828110156107a157600087878381811061069557610694611329565b5b90506020028101906106a791906114c7565b92508260000160208101906106bc91906111a7565b73ffffffffffffffffffffffffffffffffffffffff168380602001906106e2919061138f565b6040516106f0929190611431565b6000604051808303816000865af19150503d806000811461072d576040519150601f19603f3d011682016040523d82523d6000602084013e610732565b606091505b5086848151811061074657610745611329565b5b60200260200101819052819250505080610795576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161078c9061153b565b60405180910390fd5b81600101915050610678565b5050509250929050565b60006001430340905090565b600046905090565b6000806060439250434091506107d68686866109f4565b905093509350939050565b600048905090565b600043905090565b60008173ffffffffffffffffffffffffffffffffffffffff16319050919050565b600044905090565b606060008383905090508067ffffffffffffffff81111561083e5761083d6112fa565b5b60405190808252806020026020018201604052801561087757816020015b610864610bd5565b81526020019060019003908161085c5790505b5091503660005b828110156109db57600084828151811061089b5761089a611329565b5b602002602001015190508686838181106108b8576108b7611329565b5b90506020028101906108ca919061155b565b92508260000160208101906108df91906111a7565b73ffffffffffffffffffffffffffffffffffffffff16838060400190610905919061138f565b604051610913929190611431565b6000604051808303816000865af19150503d8060008114610950576040519150601f19603f3d011682016040523d82523d6000602084013e610955565b606091505b5082600001836020018290528215151515815250505080516020840135176109cf577f08c379a000000000000000000000000000000000000000000000000000000000600052602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260646000fd5b8160010191505061087e565b50505092915050565b600045905090565b600041905090565b606060008383905090508067ffffffffffffffff811115610a1857610a176112fa565b5b604051908082528060200260200182016040528015610a5157816020015b610a3e610bd5565b815260200190600190039081610a365790505b5091503660005b82811015610b9c576000848281518110610a7557610a74611329565b5b60200260200101519050868683818110610a9257610a91611329565b5b9050602002810190610aa491906114c7565b9250826000016020810190610ab991906111a7565b73ffffffffffffffffffffffffffffffffffffffff16838060200190610adf919061138f565b604051610aed929190611431565b6000604051808303816000865af19150503d8060008114610b2a576040519150601f19603f3d011682016040523d82523d6000602084013e610b2f565b606091505b508260000183602001829052821515151581525050508715610b90578060000151610b8f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610b869061153b565b60405180910390fd5b5b81600101915050610a58565b5050509392505050565b6000806060610bb7600186866107bf565b8093508194508295505050509250925092565b600081409050919050565b6040518060400160405280600015158152602001606081525090565b6000819050919050565b610c0481610bf1565b82525050565b6000602082019050610c1f6000830184610bfb565b92915050565b600080fd5b600080fd5b600080fd5b600080fd5b600080fd5b60008083601f840112610c5457610c53610c2f565b5b8235905067ffffffffffffffff811115610c7157610c70610c34565b5b602083019150836020820283011115610c8d57610c8c610c39565b5b9250929050565b60008060208385031215610cab57610caa610c25565b5b600083013567ffffffffffffffff811115610cc957610cc8610c2a565b5b610cd585828601610c3e565b92509250509250929050565b600081519050919050565b600082825260208201905092915050565b6000819050602082019050919050565b60008115159050919050565b610d2281610d0d565b82525050565b600081519050919050565b600082825260208201905092915050565b60005b83811015610d62578082015181840152602081019050610d47565b83811115610d71576000848401525b50505050565b6000601f19601f8301169050919050565b6000610d9382610d28565b610d9d8185610d33565b9350610dad818560208601610d44565b610db681610d77565b840191505092915050565b6000604083016000830151610dd96000860182610d19565b5060208301518482036020860152610df18282610d88565b9150508091505092915050565b6000610e0a8383610dc1565b905092915050565b6000602082019050919050565b6000610e2a82610ce1565b610e348185610cec565b935083602082028501610e4685610cfd565b8060005b85811015610e825784840389528151610e638582610dfe565b9450610e6e83610e12565b925060208a01995050600181019050610e4a565b50829750879550505050505092915050565b60006020820190508181036000830152610eae8184610e1f565b905092915050565b60008083601f840112610ecc57610ecb610c2f565b5b8235905067ffffffffffffffff811115610ee957610ee8610c34565b5b602083019150836020820283011115610f0557610f04610c39565b5b9250929050565b60008060208385031215610f2357610f22610c25565b5b600083013567ffffffffffffffff811115610f4157610f40610c2a565b5b610f4d85828601610eb6565b92509250509250929050565b600081519050919050565b600082825260208201905092915050565b6000819050602082019050919050565b6000610f918383610d88565b905092915050565b6000602082019050919050565b6000610fb182610f59565b610fbb8185610f64565b935083602082028501610fcd85610f75565b8060005b858110156110095784840389528151610fea8582610f85565b9450610ff583610f99565b925060208a01995050600181019050610fd1565b50829750879550505050505092915050565b60006040820190506110306000830185610bfb565b81810360208301526110428184610fa6565b90509392505050565b6000819050919050565b61105e8161104b565b82525050565b60006020820190506110796000830184611055565b92915050565b61108881610d0d565b811461109357600080fd5b50565b6000813590506110a58161107f565b92915050565b6000806000604084860312156110c4576110c3610c25565b5b60006110d286828701611096565b935050602084013567ffffffffffffffff8111156110f3576110f2610c2a565b5b6110ff86828701610eb6565b92509250509250925092565b60006060820190506111206000830186610bfb565b61112d6020830185611055565b818103604083015261113f8184610e1f565b9050949350505050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b600061117482611149565b9050919050565b61118481611169565b811461118f57600080fd5b50565b6000813590506111a18161117b565b92915050565b6000602082840312156111bd576111bc610c25565b5b60006111cb84828501611192565b91505092915050565b60008083601f8401126111ea576111e9610c2f565b5b8235905067ffffffffffffffff81111561120757611206610c34565b5b60208301915083602082028301111561122357611222610c39565b5b9250929050565b6000806020838503121561124157611240610c25565b5b600083013567ffffffffffffffff81111561125f5761125e610c2a565b5b61126b858286016111d4565b92509250509250929050565b61128081611169565b82525050565b600060208201905061129b6000830184611277565b92915050565b6112aa81610bf1565b81146112b557600080fd5b50565b6000813590506112c7816112a1565b92915050565b6000602082840312156112e3576112e2610c25565b5b60006112f1848285016112b8565b91505092915050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600080fd5b600080fd5b600080fd5b60008235600160800383360303811261138357611382611358565b5b80830191505092915050565b600080833560016020038436030381126113ac576113ab611358565b5b80840192508235915067ffffffffffffffff8211156113ce576113cd61135d565b5b6020830192506001820236038313156113ea576113e9611362565b5b509250929050565b600081905092915050565b82818337600083830152505050565b600061141883856113f2565b93506114258385846113fd565b82840190509392505050565b600061143e82848661140c565b91508190509392505050565b600082825260208201905092915050565b7f4d756c746963616c6c333a2076616c7565206d69736d61746368000000000000600082015250565b6000611491601a8361144a565b915061149c8261145b565b602082019050919050565b600060208201905081810360008301526114c081611484565b9050919050565b6000823560016040038336030381126114e3576114e2611358565b5b80830191505092915050565b7f4d756c746963616c6c333a2063616c6c206661696c6564000000000000000000600082015250565b600061152560178361144a565b9150611530826114ef565b602082019050919050565b6000602082019050818103600083015261155481611518565b9050919050565b60008235600160600383360303811261157757611576611358565b5b8083019150509291505056fea264697066735822122020c1bc9aacf8e4a6507193432a895a8e77094f45a1395583f07b24e860ef06cd64736f6c634300080c0033";

// node_modules/viem/_esm/errors/chain.js
var ChainDoesNotSupportContract2, ClientChainNotConfiguredError2;
var init_chain = __esm(() => {
  init_base();
  ChainDoesNotSupportContract2 = class ChainDoesNotSupportContract2 extends BaseError3 {
    constructor({ blockNumber, chain, contract }) {
      super(`Chain "${chain.name}" does not support contract "${contract.name}".`, {
        metaMessages: [
          "This could be due to any of the following:",
          ...blockNumber && contract.blockCreated && contract.blockCreated > blockNumber ? [
            `- The contract "${contract.name}" was not deployed until block ${contract.blockCreated} (current block ${blockNumber}).`
          ] : [
            `- The chain does not have the contract "${contract.name}" configured.`
          ]
        ],
        name: "ChainDoesNotSupportContract"
      });
    }
  };
  ClientChainNotConfiguredError2 = class ClientChainNotConfiguredError2 extends BaseError3 {
    constructor() {
      super("No chain was provided to the Client.", {
        name: "ClientChainNotConfiguredError"
      });
    }
  };
});

// node_modules/viem/_esm/utils/abi/encodeDeployData.js
function encodeDeployData2(parameters) {
  const { abi, args, bytecode } = parameters;
  if (!args || args.length === 0)
    return bytecode;
  const description = abi.find((x) => ("type" in x) && x.type === "constructor");
  if (!description)
    throw new AbiConstructorNotFoundError({ docsPath: docsPath4 });
  if (!("inputs" in description))
    throw new AbiConstructorParamsNotFoundError({ docsPath: docsPath4 });
  if (!description.inputs || description.inputs.length === 0)
    throw new AbiConstructorParamsNotFoundError({ docsPath: docsPath4 });
  const data = encodeAbiParameters(description.inputs, args);
  return concatHex([bytecode, data]);
}
var docsPath4 = "/docs/contract/encodeDeployData";
var init_encodeDeployData = __esm(() => {
  init_abi();
  init_encodeAbiParameters();
});

// node_modules/viem/_esm/utils/block/formatBlockParameter.js
function formatBlockParameter(parameters) {
  const { blockHash, blockNumber, blockTag, requireCanonical } = parameters;
  if (requireCanonical !== undefined && !blockHash)
    throw new BaseError3("`requireCanonical` can only be provided when `blockHash` is set.");
  if (blockHash)
    return requireCanonical ? { blockHash, requireCanonical } : { blockHash };
  if (typeof blockNumber === "bigint")
    return numberToHex(blockNumber);
  return blockTag ?? "latest";
}
var init_formatBlockParameter = __esm(() => {
  init_base();
  init_toHex();
});

// node_modules/viem/_esm/utils/chain/getChainContractAddress.js
function getChainContractAddress2({ blockNumber, chain, contract: name }) {
  const contract = chain?.contracts?.[name];
  if (!contract)
    throw new ChainDoesNotSupportContract2({
      chain,
      contract: { name }
    });
  if (blockNumber && contract.blockCreated && contract.blockCreated > blockNumber)
    throw new ChainDoesNotSupportContract2({
      blockNumber,
      chain,
      contract: {
        name,
        blockCreated: contract.blockCreated
      }
    });
  return contract.address;
}
var init_getChainContractAddress = __esm(() => {
  init_chain();
});

// node_modules/viem/_esm/errors/node.js
var ExecutionRevertedError2, FeeCapTooHighError2, FeeCapTooLowError2, NonceTooHighError2, NonceTooLowError2, NonceMaxValueError2, InsufficientFundsError2, IntrinsicGasTooHighError2, IntrinsicGasTooLowError2, TransactionTypeNotSupportedError2, TipAboveFeeCapError2, UnknownNodeError2;
var init_node = __esm(() => {
  init_formatGwei();
  init_base();
  ExecutionRevertedError2 = class ExecutionRevertedError2 extends BaseError3 {
    constructor({ cause, message } = {}) {
      const reason = message?.replace("execution reverted: ", "")?.replace("execution reverted", "");
      super(`Execution reverted ${reason ? `with reason: ${reason}` : "for an unknown reason"}.`, {
        cause,
        name: "ExecutionRevertedError"
      });
    }
  };
  Object.defineProperty(ExecutionRevertedError2, "code", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 3
  });
  Object.defineProperty(ExecutionRevertedError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /execution reverted|gas required exceeds allowance/
  });
  FeeCapTooHighError2 = class FeeCapTooHighError2 extends BaseError3 {
    constructor({ cause, maxFeePerGas } = {}) {
      super(`The fee cap (\`maxFeePerGas\`${maxFeePerGas ? ` = ${formatGwei3(maxFeePerGas)} gwei` : ""}) cannot be higher than the maximum allowed value (2^256-1).`, {
        cause,
        name: "FeeCapTooHighError"
      });
    }
  };
  Object.defineProperty(FeeCapTooHighError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /max fee per gas higher than 2\^256-1|fee cap higher than 2\^256-1/
  });
  FeeCapTooLowError2 = class FeeCapTooLowError2 extends BaseError3 {
    constructor({ cause, maxFeePerGas } = {}) {
      super(`The fee cap (\`maxFeePerGas\`${maxFeePerGas ? ` = ${formatGwei3(maxFeePerGas)}` : ""} gwei) cannot be lower than the block base fee.`, {
        cause,
        name: "FeeCapTooLowError"
      });
    }
  };
  Object.defineProperty(FeeCapTooLowError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /max fee per gas less than block base fee|fee cap less than block base fee|transaction is outdated/
  });
  NonceTooHighError2 = class NonceTooHighError2 extends BaseError3 {
    constructor({ cause, nonce } = {}) {
      super(`Nonce provided for the transaction ${nonce ? `(${nonce}) ` : ""}is higher than the next one expected.`, { cause, name: "NonceTooHighError" });
    }
  };
  Object.defineProperty(NonceTooHighError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /nonce too high/
  });
  NonceTooLowError2 = class NonceTooLowError2 extends BaseError3 {
    constructor({ cause, nonce } = {}) {
      super([
        `Nonce provided for the transaction ${nonce ? `(${nonce}) ` : ""}is lower than the current nonce of the account.`,
        "Try increasing the nonce or find the latest nonce with `getTransactionCount`."
      ].join(`
`), { cause, name: "NonceTooLowError" });
    }
  };
  Object.defineProperty(NonceTooLowError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /nonce too low|transaction already imported|already known/
  });
  NonceMaxValueError2 = class NonceMaxValueError2 extends BaseError3 {
    constructor({ cause, nonce } = {}) {
      super(`Nonce provided for the transaction ${nonce ? `(${nonce}) ` : ""}exceeds the maximum allowed nonce.`, { cause, name: "NonceMaxValueError" });
    }
  };
  Object.defineProperty(NonceMaxValueError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /nonce has max value/
  });
  InsufficientFundsError2 = class InsufficientFundsError2 extends BaseError3 {
    constructor({ cause } = {}) {
      super([
        "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."
      ].join(`
`), {
        cause,
        metaMessages: [
          "This error could arise when the account does not have enough funds to:",
          " - pay for the total gas fee,",
          " - pay for the value to send.",
          " ",
          "The cost of the transaction is calculated as `gas * gas fee + value`, where:",
          " - `gas` is the amount of gas needed for transaction to execute,",
          " - `gas fee` is the gas fee,",
          " - `value` is the amount of ether to send to the recipient."
        ],
        name: "InsufficientFundsError"
      });
    }
  };
  Object.defineProperty(InsufficientFundsError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /insufficient funds|exceeds transaction sender account balance/
  });
  IntrinsicGasTooHighError2 = class IntrinsicGasTooHighError2 extends BaseError3 {
    constructor({ cause, gas } = {}) {
      super(`The amount of gas ${gas ? `(${gas}) ` : ""}provided for the transaction exceeds the limit allowed for the block.`, {
        cause,
        name: "IntrinsicGasTooHighError"
      });
    }
  };
  Object.defineProperty(IntrinsicGasTooHighError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /intrinsic gas too high|gas limit reached/
  });
  IntrinsicGasTooLowError2 = class IntrinsicGasTooLowError2 extends BaseError3 {
    constructor({ cause, gas } = {}) {
      super(`The amount of gas ${gas ? `(${gas}) ` : ""}provided for the transaction is too low.`, {
        cause,
        name: "IntrinsicGasTooLowError"
      });
    }
  };
  Object.defineProperty(IntrinsicGasTooLowError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /intrinsic gas too low/
  });
  TransactionTypeNotSupportedError2 = class TransactionTypeNotSupportedError2 extends BaseError3 {
    constructor({ cause }) {
      super("The transaction type is not supported for this chain.", {
        cause,
        name: "TransactionTypeNotSupportedError"
      });
    }
  };
  Object.defineProperty(TransactionTypeNotSupportedError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /transaction type not valid/
  });
  TipAboveFeeCapError2 = class TipAboveFeeCapError2 extends BaseError3 {
    constructor({ cause, maxPriorityFeePerGas, maxFeePerGas } = {}) {
      super([
        `The provided tip (\`maxPriorityFeePerGas\`${maxPriorityFeePerGas ? ` = ${formatGwei3(maxPriorityFeePerGas)} gwei` : ""}) cannot be higher than the fee cap (\`maxFeePerGas\`${maxFeePerGas ? ` = ${formatGwei3(maxFeePerGas)} gwei` : ""}).`
      ].join(`
`), {
        cause,
        name: "TipAboveFeeCapError"
      });
    }
  };
  Object.defineProperty(TipAboveFeeCapError2, "nodeMessage", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /max priority fee per gas higher than max fee per gas|tip higher than fee cap/
  });
  UnknownNodeError2 = class UnknownNodeError2 extends BaseError3 {
    constructor({ cause }) {
      super(`An error occurred while executing: ${cause?.shortMessage}`, {
        cause,
        name: "UnknownNodeError"
      });
    }
  };
});

// node_modules/viem/_esm/utils/errors/getNodeError.js
function getNodeError(err, args) {
  const message = (err.details || "").toLowerCase();
  const executionRevertedError = err instanceof BaseError3 ? err.walk((e) => e?.code === ExecutionRevertedError2.code) : err;
  if (executionRevertedError instanceof BaseError3)
    return new ExecutionRevertedError2({
      cause: err,
      message: executionRevertedError.details
    });
  if (ExecutionRevertedError2.nodeMessage.test(message))
    return new ExecutionRevertedError2({
      cause: err,
      message: err.details
    });
  if (FeeCapTooHighError2.nodeMessage.test(message))
    return new FeeCapTooHighError2({
      cause: err,
      maxFeePerGas: args?.maxFeePerGas
    });
  if (FeeCapTooLowError2.nodeMessage.test(message))
    return new FeeCapTooLowError2({
      cause: err,
      maxFeePerGas: args?.maxFeePerGas
    });
  if (NonceTooHighError2.nodeMessage.test(message))
    return new NonceTooHighError2({ cause: err, nonce: args?.nonce });
  if (NonceTooLowError2.nodeMessage.test(message))
    return new NonceTooLowError2({ cause: err, nonce: args?.nonce });
  if (NonceMaxValueError2.nodeMessage.test(message))
    return new NonceMaxValueError2({ cause: err, nonce: args?.nonce });
  if (InsufficientFundsError2.nodeMessage.test(message))
    return new InsufficientFundsError2({ cause: err });
  if (IntrinsicGasTooHighError2.nodeMessage.test(message))
    return new IntrinsicGasTooHighError2({ cause: err, gas: args?.gas });
  if (IntrinsicGasTooLowError2.nodeMessage.test(message))
    return new IntrinsicGasTooLowError2({ cause: err, gas: args?.gas });
  if (TransactionTypeNotSupportedError2.nodeMessage.test(message))
    return new TransactionTypeNotSupportedError2({ cause: err });
  if (TipAboveFeeCapError2.nodeMessage.test(message))
    return new TipAboveFeeCapError2({
      cause: err,
      maxFeePerGas: args?.maxFeePerGas,
      maxPriorityFeePerGas: args?.maxPriorityFeePerGas
    });
  return new UnknownNodeError2({
    cause: err
  });
}
var init_getNodeError = __esm(() => {
  init_base();
  init_node();
});

// node_modules/viem/_esm/utils/errors/getCallError.js
function getCallError(err, { docsPath: docsPath5, ...args }) {
  const cause = (() => {
    const cause2 = getNodeError(err, args);
    if (cause2 instanceof UnknownNodeError2)
      return err;
    return cause2;
  })();
  return new CallExecutionError2(cause, {
    docsPath: docsPath5,
    ...args
  });
}
var init_getCallError = __esm(() => {
  init_contract();
  init_node();
  init_getNodeError();
});

// node_modules/viem/_esm/utils/formatters/extract.js
function extract(value_, { format: format2 }) {
  if (!format2)
    return {};
  const value = {};
  function extract_(formatted2) {
    const keys = Object.keys(formatted2);
    for (const key of keys) {
      if (key in value_)
        value[key] = value_[key];
      if (formatted2[key] && typeof formatted2[key] === "object" && !Array.isArray(formatted2[key]))
        extract_(formatted2[key]);
    }
  }
  const formatted = format2(value_ || {});
  extract_(formatted);
  return value;
}

// node_modules/viem/_esm/utils/formatters/transactionRequest.js
function formatTransactionRequest2(request, _) {
  const rpcRequest = {};
  if (typeof request.authorizationList !== "undefined")
    rpcRequest.authorizationList = formatAuthorizationList(request.authorizationList);
  if (typeof request.accessList !== "undefined")
    rpcRequest.accessList = request.accessList;
  if (typeof request.blobVersionedHashes !== "undefined")
    rpcRequest.blobVersionedHashes = request.blobVersionedHashes;
  if (typeof request.blobs !== "undefined") {
    if (typeof request.blobs[0] !== "string")
      rpcRequest.blobs = request.blobs.map((x) => bytesToHex(x));
    else
      rpcRequest.blobs = request.blobs;
  }
  if (typeof request.data !== "undefined")
    rpcRequest.data = request.data;
  if (request.account)
    rpcRequest.from = request.account.address;
  if (typeof request.from !== "undefined")
    rpcRequest.from = request.from;
  if (typeof request.gas !== "undefined")
    rpcRequest.gas = numberToHex(request.gas);
  if (typeof request.gasPrice !== "undefined")
    rpcRequest.gasPrice = numberToHex(request.gasPrice);
  if (typeof request.maxFeePerBlobGas !== "undefined")
    rpcRequest.maxFeePerBlobGas = numberToHex(request.maxFeePerBlobGas);
  if (typeof request.maxFeePerGas !== "undefined")
    rpcRequest.maxFeePerGas = numberToHex(request.maxFeePerGas);
  if (typeof request.maxPriorityFeePerGas !== "undefined")
    rpcRequest.maxPriorityFeePerGas = numberToHex(request.maxPriorityFeePerGas);
  if (typeof request.nonce !== "undefined")
    rpcRequest.nonce = numberToHex(request.nonce);
  if (typeof request.to !== "undefined")
    rpcRequest.to = request.to;
  if (typeof request.type !== "undefined")
    rpcRequest.type = rpcTransactionType2[request.type];
  if (typeof request.value !== "undefined")
    rpcRequest.value = numberToHex(request.value);
  return rpcRequest;
}
function formatAuthorizationList(authorizationList) {
  return authorizationList.map((authorization) => ({
    address: authorization.address,
    r: authorization.r ? numberToHex(BigInt(authorization.r)) : authorization.r,
    s: authorization.s ? numberToHex(BigInt(authorization.s)) : authorization.s,
    chainId: numberToHex(authorization.chainId),
    nonce: numberToHex(authorization.nonce),
    ...typeof authorization.yParity !== "undefined" ? { yParity: numberToHex(authorization.yParity) } : {},
    ...typeof authorization.v !== "undefined" && typeof authorization.yParity === "undefined" ? { v: numberToHex(authorization.v) } : {}
  }));
}
var rpcTransactionType2;
var init_transactionRequest = __esm(() => {
  init_toHex();
  rpcTransactionType2 = {
    legacy: "0x0",
    eip2930: "0x1",
    eip1559: "0x2",
    eip4844: "0x3",
    eip7702: "0x4"
  };
});

// node_modules/viem/_esm/utils/stateOverride.js
function serializeStateMapping(stateMapping) {
  if (!stateMapping || stateMapping.length === 0)
    return;
  return stateMapping.reduce((acc, { slot, value }) => {
    if (slot.length !== 66)
      throw new InvalidBytesLengthError({
        size: slot.length,
        targetSize: 66,
        type: "hex"
      });
    if (value.length !== 66)
      throw new InvalidBytesLengthError({
        size: value.length,
        targetSize: 66,
        type: "hex"
      });
    acc[slot] = value;
    return acc;
  }, {});
}
function serializeAccountStateOverride(parameters) {
  const { balance, nonce, state, stateDiff, code } = parameters;
  const rpcAccountStateOverride = {};
  if (code !== undefined)
    rpcAccountStateOverride.code = code;
  if (balance !== undefined)
    rpcAccountStateOverride.balance = numberToHex(balance);
  if (nonce !== undefined)
    rpcAccountStateOverride.nonce = numberToHex(nonce);
  if (state !== undefined)
    rpcAccountStateOverride.state = serializeStateMapping(state);
  if (stateDiff !== undefined) {
    if (rpcAccountStateOverride.state)
      throw new StateAssignmentConflictError2;
    rpcAccountStateOverride.stateDiff = serializeStateMapping(stateDiff);
  }
  return rpcAccountStateOverride;
}
function serializeStateOverride(parameters) {
  if (!parameters)
    return;
  const rpcStateOverride = {};
  for (const { address, ...accountState } of parameters) {
    if (!isAddress(address, { strict: false }))
      throw new InvalidAddressError({ address });
    if (rpcStateOverride[address])
      throw new AccountStateConflictError2({ address });
    rpcStateOverride[address] = serializeAccountStateOverride(accountState);
  }
  return rpcStateOverride;
}
var init_stateOverride2 = __esm(() => {
  init_address();
  init_data();
  init_stateOverride();
  init_isAddress();
  init_toHex();
});

// node_modules/viem/_esm/constants/number.js
var maxInt82, maxInt162, maxInt242, maxInt322, maxInt402, maxInt482, maxInt562, maxInt642, maxInt722, maxInt802, maxInt882, maxInt962, maxInt1042, maxInt1122, maxInt1202, maxInt1282, maxInt1362, maxInt1442, maxInt1522, maxInt1602, maxInt1682, maxInt1762, maxInt1842, maxInt1922, maxInt2002, maxInt2082, maxInt2162, maxInt2242, maxInt2322, maxInt2402, maxInt2482, maxInt2562, minInt82, minInt162, minInt242, minInt322, minInt402, minInt482, minInt562, minInt642, minInt722, minInt802, minInt882, minInt962, minInt1042, minInt1122, minInt1202, minInt1282, minInt1362, minInt1442, minInt1522, minInt1602, minInt1682, minInt1762, minInt1842, minInt1922, minInt2002, minInt2082, minInt2162, minInt2242, minInt2322, minInt2402, minInt2482, minInt2562, maxUint82, maxUint162, maxUint242, maxUint322, maxUint402, maxUint482, maxUint562, maxUint642, maxUint722, maxUint802, maxUint882, maxUint962, maxUint1042, maxUint1122, maxUint1202, maxUint1282, maxUint1362, maxUint1442, maxUint1522, maxUint1602, maxUint1682, maxUint1762, maxUint1842, maxUint1922, maxUint2002, maxUint2082, maxUint2162, maxUint2242, maxUint2322, maxUint2402, maxUint2482, maxUint2562;
var init_number = __esm(() => {
  maxInt82 = 2n ** (8n - 1n) - 1n;
  maxInt162 = 2n ** (16n - 1n) - 1n;
  maxInt242 = 2n ** (24n - 1n) - 1n;
  maxInt322 = 2n ** (32n - 1n) - 1n;
  maxInt402 = 2n ** (40n - 1n) - 1n;
  maxInt482 = 2n ** (48n - 1n) - 1n;
  maxInt562 = 2n ** (56n - 1n) - 1n;
  maxInt642 = 2n ** (64n - 1n) - 1n;
  maxInt722 = 2n ** (72n - 1n) - 1n;
  maxInt802 = 2n ** (80n - 1n) - 1n;
  maxInt882 = 2n ** (88n - 1n) - 1n;
  maxInt962 = 2n ** (96n - 1n) - 1n;
  maxInt1042 = 2n ** (104n - 1n) - 1n;
  maxInt1122 = 2n ** (112n - 1n) - 1n;
  maxInt1202 = 2n ** (120n - 1n) - 1n;
  maxInt1282 = 2n ** (128n - 1n) - 1n;
  maxInt1362 = 2n ** (136n - 1n) - 1n;
  maxInt1442 = 2n ** (144n - 1n) - 1n;
  maxInt1522 = 2n ** (152n - 1n) - 1n;
  maxInt1602 = 2n ** (160n - 1n) - 1n;
  maxInt1682 = 2n ** (168n - 1n) - 1n;
  maxInt1762 = 2n ** (176n - 1n) - 1n;
  maxInt1842 = 2n ** (184n - 1n) - 1n;
  maxInt1922 = 2n ** (192n - 1n) - 1n;
  maxInt2002 = 2n ** (200n - 1n) - 1n;
  maxInt2082 = 2n ** (208n - 1n) - 1n;
  maxInt2162 = 2n ** (216n - 1n) - 1n;
  maxInt2242 = 2n ** (224n - 1n) - 1n;
  maxInt2322 = 2n ** (232n - 1n) - 1n;
  maxInt2402 = 2n ** (240n - 1n) - 1n;
  maxInt2482 = 2n ** (248n - 1n) - 1n;
  maxInt2562 = 2n ** (256n - 1n) - 1n;
  minInt82 = -(2n ** (8n - 1n));
  minInt162 = -(2n ** (16n - 1n));
  minInt242 = -(2n ** (24n - 1n));
  minInt322 = -(2n ** (32n - 1n));
  minInt402 = -(2n ** (40n - 1n));
  minInt482 = -(2n ** (48n - 1n));
  minInt562 = -(2n ** (56n - 1n));
  minInt642 = -(2n ** (64n - 1n));
  minInt722 = -(2n ** (72n - 1n));
  minInt802 = -(2n ** (80n - 1n));
  minInt882 = -(2n ** (88n - 1n));
  minInt962 = -(2n ** (96n - 1n));
  minInt1042 = -(2n ** (104n - 1n));
  minInt1122 = -(2n ** (112n - 1n));
  minInt1202 = -(2n ** (120n - 1n));
  minInt1282 = -(2n ** (128n - 1n));
  minInt1362 = -(2n ** (136n - 1n));
  minInt1442 = -(2n ** (144n - 1n));
  minInt1522 = -(2n ** (152n - 1n));
  minInt1602 = -(2n ** (160n - 1n));
  minInt1682 = -(2n ** (168n - 1n));
  minInt1762 = -(2n ** (176n - 1n));
  minInt1842 = -(2n ** (184n - 1n));
  minInt1922 = -(2n ** (192n - 1n));
  minInt2002 = -(2n ** (200n - 1n));
  minInt2082 = -(2n ** (208n - 1n));
  minInt2162 = -(2n ** (216n - 1n));
  minInt2242 = -(2n ** (224n - 1n));
  minInt2322 = -(2n ** (232n - 1n));
  minInt2402 = -(2n ** (240n - 1n));
  minInt2482 = -(2n ** (248n - 1n));
  minInt2562 = -(2n ** (256n - 1n));
  maxUint82 = 2n ** 8n - 1n;
  maxUint162 = 2n ** 16n - 1n;
  maxUint242 = 2n ** 24n - 1n;
  maxUint322 = 2n ** 32n - 1n;
  maxUint402 = 2n ** 40n - 1n;
  maxUint482 = 2n ** 48n - 1n;
  maxUint562 = 2n ** 56n - 1n;
  maxUint642 = 2n ** 64n - 1n;
  maxUint722 = 2n ** 72n - 1n;
  maxUint802 = 2n ** 80n - 1n;
  maxUint882 = 2n ** 88n - 1n;
  maxUint962 = 2n ** 96n - 1n;
  maxUint1042 = 2n ** 104n - 1n;
  maxUint1122 = 2n ** 112n - 1n;
  maxUint1202 = 2n ** 120n - 1n;
  maxUint1282 = 2n ** 128n - 1n;
  maxUint1362 = 2n ** 136n - 1n;
  maxUint1442 = 2n ** 144n - 1n;
  maxUint1522 = 2n ** 152n - 1n;
  maxUint1602 = 2n ** 160n - 1n;
  maxUint1682 = 2n ** 168n - 1n;
  maxUint1762 = 2n ** 176n - 1n;
  maxUint1842 = 2n ** 184n - 1n;
  maxUint1922 = 2n ** 192n - 1n;
  maxUint2002 = 2n ** 200n - 1n;
  maxUint2082 = 2n ** 208n - 1n;
  maxUint2162 = 2n ** 216n - 1n;
  maxUint2242 = 2n ** 224n - 1n;
  maxUint2322 = 2n ** 232n - 1n;
  maxUint2402 = 2n ** 240n - 1n;
  maxUint2482 = 2n ** 248n - 1n;
  maxUint2562 = 2n ** 256n - 1n;
});

// node_modules/viem/_esm/utils/transaction/assertRequest.js
function assertRequest2(args) {
  const { account: account_, maxFeePerGas, maxPriorityFeePerGas, to } = args;
  const account = account_ ? parseAccount(account_) : undefined;
  if (account && !isAddress(account.address))
    throw new InvalidAddressError({ address: account.address });
  if (to && !isAddress(to))
    throw new InvalidAddressError({ address: to });
  if (maxFeePerGas && maxFeePerGas > maxUint2562)
    throw new FeeCapTooHighError2({ maxFeePerGas });
  if (maxPriorityFeePerGas && maxFeePerGas && maxPriorityFeePerGas > maxFeePerGas)
    throw new TipAboveFeeCapError2({ maxFeePerGas, maxPriorityFeePerGas });
}
var init_assertRequest = __esm(() => {
  init_number();
  init_address();
  init_node();
  init_isAddress();
});

// node_modules/viem/_esm/errors/ccip.js
var OffchainLookupError, OffchainLookupResponseMalformedError, OffchainLookupSenderMismatchError;
var init_ccip = __esm(() => {
  init_base();
  OffchainLookupError = class OffchainLookupError extends BaseError3 {
    constructor({ callbackSelector, cause, data, extraData, sender, urls }) {
      super(cause.shortMessage || "An error occurred while fetching for an offchain result.", {
        cause,
        metaMessages: [
          ...cause.metaMessages || [],
          cause.metaMessages?.length ? "" : [],
          "Offchain Gateway Call:",
          urls && [
            "  Gateway URL(s):",
            ...urls.map((url) => `    ${getUrl(url)}`)
          ],
          `  Sender: ${sender}`,
          `  Data: ${data}`,
          `  Callback selector: ${callbackSelector}`,
          `  Extra data: ${extraData}`
        ].flat(),
        name: "OffchainLookupError"
      });
    }
  };
  OffchainLookupResponseMalformedError = class OffchainLookupResponseMalformedError extends BaseError3 {
    constructor({ result, url }) {
      super("Offchain gateway response is malformed. Response data must be a hex value.", {
        metaMessages: [
          `Gateway URL: ${getUrl(url)}`,
          `Response: ${stringify(result)}`
        ],
        name: "OffchainLookupResponseMalformedError"
      });
    }
  };
  OffchainLookupSenderMismatchError = class OffchainLookupSenderMismatchError extends BaseError3 {
    constructor({ sender, to }) {
      super("Reverted sender address does not match target contract address (`to`).", {
        metaMessages: [
          `Contract address: ${to}`,
          `OffchainLookup sender address: ${sender}`
        ],
        name: "OffchainLookupSenderMismatchError"
      });
    }
  };
});

// node_modules/viem/_esm/utils/abi/decodeFunctionData.js
function decodeFunctionData2(parameters) {
  const { abi, data } = parameters;
  const signature = slice(data, 0, 4);
  const description = abi.find((x) => x.type === "function" && signature === toFunctionSelector3(formatAbiItem2(x)));
  if (!description)
    throw new AbiFunctionSignatureNotFoundError(signature, {
      docsPath: "/docs/contract/decodeFunctionData"
    });
  return {
    functionName: description.name,
    args: "inputs" in description && description.inputs && description.inputs.length > 0 ? decodeAbiParameters(description.inputs, slice(data, 4)) : undefined
  };
}
var init_decodeFunctionData = __esm(() => {
  init_abi();
  init_slice();
  init_toFunctionSelector();
  init_decodeAbiParameters();
  init_formatAbiItem2();
});

// node_modules/viem/_esm/utils/abi/encodeErrorResult.js
function encodeErrorResult2(parameters) {
  const { abi, errorName, args } = parameters;
  let abiItem = abi[0];
  if (errorName) {
    const item = getAbiItem2({ abi, args, name: errorName });
    if (!item)
      throw new AbiErrorNotFoundError(errorName, { docsPath: docsPath5 });
    abiItem = item;
  }
  if (abiItem.type !== "error")
    throw new AbiErrorNotFoundError(undefined, { docsPath: docsPath5 });
  const definition = formatAbiItem2(abiItem);
  const signature = toFunctionSelector3(definition);
  let data = "0x";
  if (args && args.length > 0) {
    if (!abiItem.inputs)
      throw new AbiErrorInputsNotFoundError(abiItem.name, { docsPath: docsPath5 });
    data = encodeAbiParameters(abiItem.inputs, args);
  }
  return concatHex([signature, data]);
}
var docsPath5 = "/docs/contract/encodeErrorResult";
var init_encodeErrorResult = __esm(() => {
  init_abi();
  init_toFunctionSelector();
  init_encodeAbiParameters();
  init_formatAbiItem2();
  init_getAbiItem();
});

// node_modules/viem/_esm/utils/abi/encodeFunctionResult.js
function encodeFunctionResult2(parameters) {
  const { abi, functionName, result } = parameters;
  let abiItem = abi[0];
  if (functionName) {
    const item = getAbiItem2({ abi, name: functionName });
    if (!item)
      throw new AbiFunctionNotFoundError(functionName, { docsPath: docsPath6 });
    abiItem = item;
  }
  if (abiItem.type !== "function")
    throw new AbiFunctionNotFoundError(undefined, { docsPath: docsPath6 });
  if (!abiItem.outputs)
    throw new AbiFunctionOutputsNotFoundError(abiItem.name, { docsPath: docsPath6 });
  const values = (() => {
    if (abiItem.outputs.length === 0)
      return [];
    if (abiItem.outputs.length === 1)
      return [result];
    if (Array.isArray(result))
      return result;
    throw new InvalidArrayError(result);
  })();
  return encodeAbiParameters(abiItem.outputs, values);
}
var docsPath6 = "/docs/contract/encodeFunctionResult";
var init_encodeFunctionResult = __esm(() => {
  init_abi();
  init_encodeAbiParameters();
  init_getAbiItem();
});

// node_modules/viem/_esm/utils/ens/localBatchGatewayRequest.js
async function localBatchGatewayRequest(parameters) {
  const { data, ccipRequest: ccipRequest3 } = parameters;
  const { args: [queries] } = decodeFunctionData2({ abi: batchGatewayAbi, data });
  const failures = [];
  const responses = [];
  await Promise.all(queries.map(async (query, i) => {
    try {
      responses[i] = query.urls.includes(localBatchGatewayUrl) ? await localBatchGatewayRequest({ data: query.data, ccipRequest: ccipRequest3 }) : await ccipRequest3(query);
      failures[i] = false;
    } catch (err) {
      failures[i] = true;
      responses[i] = encodeError(err);
    }
  }));
  return encodeFunctionResult2({
    abi: batchGatewayAbi,
    functionName: "query",
    result: [failures, responses]
  });
}
function encodeError(error) {
  if (error.name === "HttpRequestError" && error.status)
    return encodeErrorResult2({
      abi: batchGatewayAbi,
      errorName: "HttpError",
      args: [error.status, error.shortMessage]
    });
  return encodeErrorResult2({
    abi: [solidityError],
    errorName: "Error",
    args: ["shortMessage" in error ? error.shortMessage : error.message]
  });
}
var localBatchGatewayUrl = "x-batch-gateway:true";
var init_localBatchGatewayRequest = __esm(() => {
  init_abis();
  init_solidity();
  init_decodeFunctionData();
  init_encodeErrorResult();
  init_encodeFunctionResult();
});

// node_modules/viem/_esm/utils/ccip.js
var exports_ccip = {};
__export(exports_ccip, {
  offchainLookupSignature: () => offchainLookupSignature2,
  offchainLookupAbiItem: () => offchainLookupAbiItem2,
  offchainLookup: () => offchainLookup2,
  ccipRequest: () => ccipRequest3
});
async function offchainLookup2(client, { blockNumber, blockTag, data, requestOptions, to }) {
  const { args } = decodeErrorResult2({
    data,
    abi: [offchainLookupAbiItem2]
  });
  const [sender, urls, callData, callbackSelector, extraData] = args;
  const { ccipRead } = client;
  const ccipRequest_ = ccipRead && typeof ccipRead?.request === "function" ? ccipRead.request : ccipRequest3;
  try {
    if (!isAddressEqual(to, sender))
      throw new OffchainLookupSenderMismatchError({ sender, to });
    const result = urls.includes(localBatchGatewayUrl) ? await localBatchGatewayRequest({
      data: callData,
      ccipRequest: (parameters) => ccipRequest_({ ...parameters, requestOptions })
    }) : await ccipRequest_({ data: callData, requestOptions, sender, urls });
    const { data: data_ } = await call(client, {
      blockNumber,
      blockTag,
      data: concat([
        callbackSelector,
        encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [result, extraData])
      ]),
      requestOptions,
      to
    });
    return data_;
  } catch (err) {
    if (requestOptions?.signal?.aborted)
      throw getAbortError(requestOptions.signal);
    if (isAbortError(err))
      throw err;
    throw new OffchainLookupError({
      callbackSelector,
      cause: err,
      data,
      extraData,
      sender,
      urls
    });
  }
}
async function ccipRequest3({ data, requestOptions, sender, urls }) {
  let error = new Error("An unknown error occurred.");
  for (let i = 0;i < urls.length; i++) {
    if (requestOptions?.signal?.aborted)
      throw getAbortError(requestOptions.signal);
    const url = urls[i];
    const method = url.includes("{data}") ? "GET" : "POST";
    const body = method === "POST" ? { data, sender } : undefined;
    const headers = method === "POST" ? { "Content-Type": "application/json" } : {};
    try {
      const response = await fetch(url.replace("{sender}", sender.toLowerCase()).replace("{data}", data), {
        body: JSON.stringify(body),
        headers,
        method,
        ...requestOptions?.signal ? { signal: requestOptions.signal } : {}
      });
      let result;
      if (response.headers.get("Content-Type")?.startsWith("application/json")) {
        result = (await response.json()).data;
      } else {
        result = await response.text();
      }
      if (!response.ok) {
        error = new HttpRequestError({
          body,
          details: result?.error ? stringify(result.error) : response.statusText,
          headers: response.headers,
          status: response.status,
          url
        });
        continue;
      }
      if (!isHex(result)) {
        error = new OffchainLookupResponseMalformedError({
          result,
          url
        });
        continue;
      }
      return result;
    } catch (err) {
      if (requestOptions?.signal?.aborted)
        throw getAbortError(requestOptions.signal);
      if (isAbortError(err))
        throw err;
      error = new HttpRequestError({
        body,
        details: err.message,
        url
      });
    }
  }
  throw error;
}
var offchainLookupSignature2 = "0x556f1830", offchainLookupAbiItem2;
var init_ccip2 = __esm(() => {
  init_call();
  init_ccip();
  init_request();
  init_decodeErrorResult();
  init_encodeAbiParameters();
  init_isAddressEqual();
  init_localBatchGatewayRequest();
  offchainLookupAbiItem2 = {
    name: "OffchainLookup",
    type: "error",
    inputs: [
      {
        name: "sender",
        type: "address"
      },
      {
        name: "urls",
        type: "string[]"
      },
      {
        name: "callData",
        type: "bytes"
      },
      {
        name: "callbackFunction",
        type: "bytes4"
      },
      {
        name: "extraData",
        type: "bytes"
      }
    ]
  };
});

// node_modules/viem/_esm/actions/public/call.js
async function call(client, args) {
  const { account: account_ = client.account, authorizationList, batch = Boolean(client.batch?.multicall), blockHash, blockNumber, blockTag = client.experimental_blockTag ?? "latest", requireCanonical, accessList, blobs, blockOverrides, code, data: data_, factory, factoryData, gas, gasPrice, maxFeePerBlobGas, maxFeePerGas, maxPriorityFeePerGas, nonce, requestOptions, to, value, stateOverride, ...rest } = args;
  const account = account_ ? parseAccount(account_) : undefined;
  if (code && (factory || factoryData))
    throw new BaseError3("Cannot provide both `code` & `factory`/`factoryData` as parameters.");
  if (code && to)
    throw new BaseError3("Cannot provide both `code` & `to` as parameters.");
  const deploylessCallViaBytecode = code && data_;
  const deploylessCallViaFactory = factory && factoryData && to && data_;
  const deploylessCall = deploylessCallViaBytecode || deploylessCallViaFactory;
  const data = (() => {
    if (deploylessCallViaBytecode)
      return toDeploylessCallViaBytecodeData({
        code,
        data: data_
      });
    if (deploylessCallViaFactory)
      return toDeploylessCallViaFactoryData({
        data: data_,
        factory,
        factoryData,
        to
      });
    return data_;
  })();
  try {
    assertRequest2(args);
    const block = formatBlockParameter({
      blockHash,
      blockNumber,
      blockTag,
      requireCanonical
    });
    const rpcBlockOverrides = blockOverrides ? toRpc2(blockOverrides) : undefined;
    const rpcStateOverride = serializeStateOverride(stateOverride);
    const chainFormat = client.chain?.formatters?.transactionRequest?.format;
    const format2 = chainFormat || formatTransactionRequest2;
    const request = format2({
      ...extract(rest, { format: chainFormat }),
      accessList,
      account,
      authorizationList,
      blobs,
      data,
      gas,
      gasPrice,
      maxFeePerBlobGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      to: deploylessCall ? undefined : to,
      value
    }, "call");
    if (batch && shouldPerformMulticall({ request }) && !rpcBlockOverrides && blockHash === undefined) {
      try {
        const { deployless = false } = typeof client.batch?.multicall === "object" ? client.batch.multicall : {};
        const multicallAddress = getMulticallAddress(client, {
          blockNumber,
          deployless
        });
        if (!multicallAddress || !hasStateOverrideForAddress(rpcStateOverride, multicallAddress))
          return await scheduleMulticall(client, {
            ...request,
            blockHash,
            blockNumber,
            blockTag,
            multicallAddress,
            requestOptions,
            requireCanonical,
            rpcStateOverride
          });
      } catch (err) {
        if (!(err instanceof ClientChainNotConfiguredError2) && !(err instanceof ChainDoesNotSupportContract2))
          throw err;
      }
    }
    const params = (() => {
      const base = [
        request,
        block
      ];
      if (rpcStateOverride && rpcBlockOverrides)
        return [...base, rpcStateOverride, rpcBlockOverrides];
      if (rpcStateOverride)
        return [...base, rpcStateOverride];
      if (rpcBlockOverrides)
        return [...base, {}, rpcBlockOverrides];
      return base;
    })();
    const response = await client.request({
      method: "eth_call",
      params
    }, requestOptions);
    if (response === "0x")
      return { data: undefined };
    return { data: response };
  } catch (err) {
    if (requestOptions?.signal?.aborted)
      throw getAbortError(requestOptions.signal);
    if (isAbortError(err))
      throw err;
    const data2 = getRevertErrorData(err);
    const { offchainLookup: offchainLookup3, offchainLookupSignature: offchainLookupSignature3 } = await Promise.resolve().then(() => (init_ccip2(), exports_ccip));
    if (client.ccipRead !== false && data2?.slice(0, 10) === offchainLookupSignature3 && to)
      return {
        data: await offchainLookup3(client, { data: data2, requestOptions, to })
      };
    if (deploylessCall && data2?.slice(0, 10) === "0x101bb98d")
      throw new CounterfactualDeploymentFailedError2({ factory });
    throw getCallError(err, {
      ...args,
      account,
      chain: client.chain
    });
  }
}
function shouldPerformMulticall({ request }) {
  const { data, to, ...request_ } = request;
  if (!data)
    return false;
  if (data.startsWith(aggregate3Signature))
    return false;
  if (!to)
    return false;
  if (Object.values(request_).filter((x) => typeof x !== "undefined").length > 0)
    return false;
  return true;
}
function getRequestOptionsId(requestOptions) {
  if (!requestOptions)
    return "default";
  const id = requestOptionsIds.get(requestOptions);
  if (id !== undefined)
    return id;
  const nextId = requestOptionsId++;
  requestOptionsIds.set(requestOptions, nextId);
  return nextId;
}
async function scheduleMulticall(client, args) {
  const { batchSize = 1024, deployless = false, wait: wait2 = 0 } = typeof client.batch?.multicall === "object" ? client.batch.multicall : {};
  const { blockHash, blockNumber, blockTag = client.experimental_blockTag ?? "latest", requireCanonical, data, multicallAddress: multicallAddress_, requestOptions, rpcStateOverride, to } = args;
  const multicallAddress = multicallAddress_ !== undefined ? multicallAddress_ : getMulticallAddress(client, {
    blockNumber,
    deployless
  });
  const block = formatBlockParameter({
    blockHash,
    blockNumber,
    blockTag,
    requireCanonical
  });
  const blockId = typeof block === "string" ? block : JSON.stringify(block);
  const stateOverrideKey = rpcStateOverride ? `.${JSON.stringify(rpcStateOverride)}` : "";
  const { schedule } = createBatchScheduler({
    id: `${client.uid}.${blockId}.${getRequestOptionsId(requestOptions)}${stateOverrideKey}`,
    wait: wait2,
    shouldSplitBatch(args2) {
      const size5 = args2.reduce((size6, { data: data2 }) => size6 + (data2.length - 2), 0);
      return size5 > batchSize * 2;
    },
    fn: async (requests) => {
      const calls = requests.map((request) => ({
        allowFailure: true,
        callData: request.data,
        target: request.to
      }));
      const calldata = encodeFunctionData2({
        abi: multicall3Abi2,
        args: [calls],
        functionName: "aggregate3"
      });
      const multicallRequest = {
        ...multicallAddress === null ? {
          data: toDeploylessCallViaBytecodeData({
            code: multicall3Bytecode,
            data: calldata
          })
        } : { to: multicallAddress, data: calldata }
      };
      const data2 = await client.request({
        method: "eth_call",
        params: rpcStateOverride ? [multicallRequest, block, rpcStateOverride] : [multicallRequest, block]
      }, requestOptions);
      return decodeFunctionResult2({
        abi: multicall3Abi2,
        args: [calls],
        functionName: "aggregate3",
        data: data2 || "0x"
      });
    }
  });
  const [{ returnData, success }] = await schedule({ data, to });
  if (!success)
    throw new RawContractError2({ data: returnData });
  if (returnData === "0x")
    return { data: undefined };
  return { data: returnData };
}
function getMulticallAddress(client, parameters) {
  const { blockNumber, deployless } = parameters;
  if (deployless)
    return null;
  if (client.chain)
    return getChainContractAddress2({
      blockNumber,
      chain: client.chain,
      contract: "multicall3"
    });
  throw new ClientChainNotConfiguredError2;
}
function hasStateOverrideForAddress(rpcStateOverride, address) {
  if (!rpcStateOverride)
    return false;
  return Object.keys(rpcStateOverride).some((stateOverrideAddress) => isAddressEqual(stateOverrideAddress, address));
}
function toDeploylessCallViaBytecodeData(parameters) {
  const { code, data } = parameters;
  return encodeDeployData2({
    abi: parseAbi(["constructor(bytes, bytes)"]),
    bytecode: deploylessCallViaBytecodeBytecode2,
    args: [code, data]
  });
}
function toDeploylessCallViaFactoryData(parameters) {
  const { data, factory, factoryData, to } = parameters;
  return encodeDeployData2({
    abi: parseAbi(["constructor(address, bytes, address, bytes)"]),
    bytecode: deploylessCallViaFactoryBytecode2,
    args: [to, data, factory, factoryData]
  });
}
function getRevertErrorData(err) {
  if (!(err instanceof BaseError3))
    return;
  const error = err.walk();
  return typeof error?.data === "object" ? error.data?.data : error.data;
}
var requestOptionsId = 0, requestOptionsIds;
var init_call = __esm(() => {
  init_exports();
  init_BlockOverrides();
  init_abis();
  init_base();
  init_chain();
  init_contract();
  init_decodeFunctionResult();
  init_encodeDeployData();
  init_encodeFunctionData();
  init_isAddressEqual();
  init_formatBlockParameter();
  init_getChainContractAddress();
  init_getCallError();
  init_transactionRequest();
  init_createBatchScheduler();
  init_stateOverride2();
  init_assertRequest();
  requestOptionsIds = new WeakMap;
});

// node_modules/viem/_esm/index.js
init_exports();
// node_modules/viem/_esm/utils/uid.js
var size = 256;
var index = size;
var buffer;
function uid(length = 11) {
  if (!buffer || index + length > size * 2) {
    buffer = "";
    index = 0;
    for (let i = 0;i < size; i++) {
      buffer += (256 + Math.random() * 256 | 0).toString(16).substring(1);
    }
  }
  return buffer.substring(index, index++ + length);
}

// node_modules/viem/_esm/clients/createClient.js
function createClient(parameters) {
  const { batch, chain, ccipRead, dataSuffix, key = "base", name = "Base Client", tokens, type = "base" } = parameters;
  const experimental_blockTag = parameters.experimental_blockTag ?? (typeof chain?.experimental_preconfirmationTime === "number" ? "pending" : undefined);
  const blockTime = chain?.blockTime ?? 12000;
  const defaultPollingInterval = Math.min(Math.max(Math.floor(blockTime / 2), 500), 4000);
  const pollingInterval = parameters.pollingInterval ?? defaultPollingInterval;
  const cacheTime = parameters.cacheTime ?? pollingInterval;
  const account = parameters.account ? parseAccount(parameters.account) : undefined;
  const { config, request, value } = parameters.transport({
    account,
    chain,
    pollingInterval
  });
  const transport = { ...config, ...value };
  const client = {
    account,
    batch,
    cacheTime,
    ccipRead,
    chain,
    dataSuffix,
    key,
    name,
    pollingInterval,
    request,
    tokens,
    transport,
    type,
    uid: uid(),
    ...experimental_blockTag ? { experimental_blockTag } : {}
  };
  function extend(base) {
    return (extendFn) => {
      const extended = extendFn(base);
      for (const key2 in client)
        delete extended[key2];
      const combined = { ...base, ...extended };
      for (const key2 in extended) {
        const a = base[key2];
        const b = extended[key2];
        if (isPlainObject(a) && isPlainObject(b))
          combined[key2] = { ...a, ...b };
      }
      return Object.assign(combined, { extend: extend(combined) });
    };
  }
  return Object.assign(client, { extend: extend(client) });
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
// node_modules/viem/_esm/clients/transports/http.js
init_request();

// node_modules/viem/_esm/errors/transport.js
init_base();

class UrlRequiredError extends BaseError3 {
  constructor() {
    super("No URL was provided to the Transport. Please provide a valid RPC URL to the Transport.", {
      docsPath: "/docs/clients/intro",
      name: "UrlRequiredError"
    });
  }
}

// node_modules/viem/_esm/clients/transports/http.js
init_createBatchScheduler();

// node_modules/viem/_esm/utils/rpc/http.js
init_request();

// node_modules/viem/_esm/utils/promise/withTimeout.js
function withTimeout(fn, { errorInstance = new Error("timed out"), timeout, signal }) {
  return new Promise((resolve, reject) => {
    (async () => {
      let timeoutId;
      const controller = new AbortController;
      try {
        if (timeout > 0) {
          timeoutId = setTimeout(() => {
            if (signal) {
              controller.abort();
            } else {
              reject(errorInstance);
            }
          }, timeout);
        }
        resolve(await fn({ signal: controller?.signal || null }));
      } catch (err) {
        if (controller?.signal.aborted && isAbortError(err)) {
          reject(errorInstance);
          return;
        }
        reject(err);
      } finally {
        clearTimeout(timeoutId);
      }
    })();
  });
}
// node_modules/viem/_esm/utils/rpc/id.js
function createIdStore() {
  return {
    current: 0,
    take() {
      return this.current++;
    },
    reset() {
      this.current = 0;
    }
  };
}
var idCache = /* @__PURE__ */ createIdStore();

// node_modules/viem/_esm/utils/rpc/http.js
var defaultMaxResponseBodySize = 10485760;
function getHttpRpcClient(url_, options = {}) {
  const { url, headers: headers_url } = parseUrl(url_);
  return {
    async request(params) {
      const { body, fetchFn = options.fetchFn ?? fetch, maxResponseBodySize = options.maxResponseBodySize ?? defaultMaxResponseBodySize, onRequest = options.onRequest, onResponse = options.onResponse, timeout = options.timeout ?? 1e4 } = params;
      const fetchOptions = {
        ...options.fetchOptions ?? {},
        ...params.fetchOptions ?? {}
      };
      const { headers, method, signal: signal_ } = fetchOptions;
      try {
        const response = await withTimeout(async ({ signal }) => {
          const init = {
            ...fetchOptions,
            body: Array.isArray(body) ? stringify(body.map((body2) => ({
              jsonrpc: "2.0",
              id: body2.id ?? idCache.take(),
              ...body2
            }))) : stringify({
              jsonrpc: "2.0",
              id: body.id ?? idCache.take(),
              ...body
            }),
            headers: {
              ...headers_url,
              "Content-Type": "application/json",
              ...headers
            },
            method: method || "POST",
            signal: signal_ || (timeout > 0 ? signal : null)
          };
          const request = new Request(url, init);
          const args = await onRequest?.(request, init) ?? { ...init, url };
          const response2 = await fetchFn(args.url ?? url, args);
          return response2;
        }, {
          errorInstance: new TimeoutError({ body, url }),
          timeout,
          signal: true
        });
        if (onResponse)
          await onResponse(response);
        let data;
        const responseBody = await readResponseBody(response, {
          maxResponseBodySize
        });
        if (response.headers.get("Content-Type")?.startsWith("application/json"))
          data = JSON.parse(responseBody);
        else {
          data = responseBody;
          try {
            data = JSON.parse(data || "{}");
          } catch (err) {
            if (response.ok)
              throw err;
            data = { error: data };
          }
        }
        if (!response.ok) {
          if (typeof data.error?.code === "number" && typeof data.error?.message === "string")
            return data;
          throw new HttpRequestError({
            body,
            details: stringify(data.error) || response.statusText,
            headers: response.headers,
            status: response.status,
            url
          });
        }
        return data;
      } catch (err) {
        if (signal_?.aborted)
          throw getAbortError(signal_);
        if (isAbortError(err))
          throw err;
        if (err instanceof HttpRequestError)
          throw err;
        if (err instanceof ResponseBodyTooLargeError)
          throw err;
        if (err instanceof TimeoutError)
          throw err;
        throw new HttpRequestError({
          body,
          cause: err,
          url
        });
      }
    }
  };
}
async function readResponseBody(response, { maxResponseBodySize }) {
  if (maxResponseBodySize === false)
    return response.text();
  const contentLength = response.headers.get("Content-Length");
  if (contentLength) {
    const size3 = Number(contentLength);
    if (size3 > maxResponseBodySize)
      throw new ResponseBodyTooLargeError({
        maxSize: maxResponseBodySize,
        size: size3
      });
  }
  if (!response.body) {
    const body2 = await response.text();
    const size3 = new TextEncoder().encode(body2).length;
    if (size3 > maxResponseBodySize)
      throw new ResponseBodyTooLargeError({
        maxSize: maxResponseBodySize,
        size: size3
      });
    return body2;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder;
  let body = "";
  let size2 = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size2 += value.byteLength;
      if (size2 > maxResponseBodySize) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError({
          maxSize: maxResponseBodySize,
          size: size2
        });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}
function parseUrl(url_) {
  try {
    const url = new URL(url_);
    const result = (() => {
      if (url.username) {
        const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        url.username = "";
        url.password = "";
        return {
          url: url.toString(),
          headers: { Authorization: `Basic ${btoa(credentials)}` }
        };
      }
      return;
    })();
    return { url: url.toString(), ...result };
  } catch {
    return { url: url_ };
  }
}

// node_modules/viem/_esm/utils/buildRequest.js
init_base();
init_request();
init_rpc();

// node_modules/viem/_esm/utils/promise/withDedupe.js
init_lru();
var promiseCache = /* @__PURE__ */ new LruMap(8192);
function withDedupe(fn, { enabled = true, id }) {
  if (!enabled || !id)
    return fn();
  if (promiseCache.get(id))
    return promiseCache.get(id);
  const promise = fn().finally(() => promiseCache.delete(id));
  promiseCache.set(id, promise);
  return promise;
}
// node_modules/viem/_esm/utils/wait.js
async function wait(time, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(getAbortError(signal));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, time);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(getAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// node_modules/viem/_esm/utils/promise/withRetry.js
function withRetry(fn, { delay: delay_ = 100, retryCount = 2, shouldRetry = () => true, signal } = {}) {
  return new Promise((resolve, reject) => {
    const attemptRetry = async ({ count = 0 } = {}) => {
      if (signal?.aborted) {
        reject(getAbortError(signal));
        return;
      }
      const retry = async ({ error }) => {
        const delay = typeof delay_ === "function" ? delay_({ count, error }) : delay_;
        if (delay) {
          try {
            await wait(delay, { signal });
          } catch (err) {
            reject(err);
            return;
          }
        }
        return attemptRetry({ count: count + 1 });
      };
      try {
        const data = await fn();
        resolve(data);
      } catch (err) {
        if (signal?.aborted) {
          reject(getAbortError(signal));
          return;
        }
        if (isAbortError(err)) {
          reject(err);
          return;
        }
        if (count < retryCount && await shouldRetry({ count, error: err }))
          return retry({ error: err });
        reject(err);
      }
    };
    attemptRetry().catch(reject);
  });
}

// node_modules/viem/_esm/utils/buildRequest.js
function buildRequest(request, options = {}) {
  return async (args, overrideOptions = {}) => {
    const { dedupe = false, methods, retryDelay = 150, retryCount = 3, signal, uid: uid2 } = {
      ...options,
      ...overrideOptions
    };
    const { method } = args;
    if (methods?.exclude?.includes(method))
      throw new MethodNotSupportedRpcError(new Error("method not supported"), {
        method
      });
    if (methods?.include && !methods.include.includes(method))
      throw new MethodNotSupportedRpcError(new Error("method not supported"), {
        method
      });
    if (signal?.aborted)
      throw getAbortError(signal);
    const requestId = dedupe ? hashString(`${uid2}.${stringify(args)}`) : undefined;
    return withDedupe(() => withRetry(async () => {
      try {
        return await request(args, signal ? { signal } : undefined);
      } catch (err_) {
        if (signal?.aborted)
          throw getAbortError(signal);
        if (isAbortError(err_))
          throw err_;
        const err = err_;
        switch (err.code) {
          case ParseRpcError.code:
            throw new ParseRpcError(err);
          case InvalidRequestRpcError.code:
            throw new InvalidRequestRpcError(err);
          case MethodNotFoundRpcError.code:
            throw new MethodNotFoundRpcError(err, { method: args.method });
          case InvalidParamsRpcError.code:
            throw new InvalidParamsRpcError(err);
          case InternalRpcError.code:
            throw new InternalRpcError(err);
          case InvalidInputRpcError.code:
            throw new InvalidInputRpcError(err);
          case ResourceNotFoundRpcError.code:
            throw new ResourceNotFoundRpcError(err);
          case ResourceUnavailableRpcError.code:
            throw new ResourceUnavailableRpcError(err);
          case TransactionRejectedRpcError.code:
            throw new TransactionRejectedRpcError(err);
          case MethodNotSupportedRpcError.code:
            throw new MethodNotSupportedRpcError(err, {
              method: args.method
            });
          case LimitExceededRpcError.code:
            throw new LimitExceededRpcError(err);
          case JsonRpcVersionUnsupportedError.code:
            throw new JsonRpcVersionUnsupportedError(err);
          case UserRejectedRequestError.code:
            throw new UserRejectedRequestError(err);
          case UnauthorizedProviderError.code:
            throw new UnauthorizedProviderError(err);
          case UnsupportedProviderMethodError.code:
            throw new UnsupportedProviderMethodError(err);
          case ProviderDisconnectedError.code:
            throw new ProviderDisconnectedError(err);
          case ChainDisconnectedError.code:
            throw new ChainDisconnectedError(err);
          case SwitchChainError.code:
            throw new SwitchChainError(err);
          case UnsupportedNonOptionalCapabilityError.code:
            throw new UnsupportedNonOptionalCapabilityError(err);
          case UnsupportedChainIdError.code:
            throw new UnsupportedChainIdError(err);
          case DuplicateIdError.code:
            throw new DuplicateIdError(err);
          case UnknownBundleIdError.code:
            throw new UnknownBundleIdError(err);
          case BundleTooLargeError.code:
            throw new BundleTooLargeError(err);
          case AtomicReadyWalletRejectedUpgradeError.code:
            throw new AtomicReadyWalletRejectedUpgradeError(err);
          case AtomicityNotSupportedError.code:
            throw new AtomicityNotSupportedError(err);
          case 5000:
            throw new UserRejectedRequestError(err);
          case WalletConnectSessionSettlementError.code:
            throw new WalletConnectSessionSettlementError(err);
          default:
            if (err_ instanceof BaseError3)
              throw err_;
            throw new UnknownRpcError(err);
        }
      }
    }, {
      delay: ({ count, error }) => {
        if (error && error instanceof HttpRequestError) {
          const retryAfter = error?.headers?.get("Retry-After");
          if (retryAfter?.match(/\d/))
            return Number.parseInt(retryAfter, 10) * 1000;
        }
        return ~~(1 << count) * retryDelay;
      },
      retryCount,
      signal,
      shouldRetry: ({ error }) => shouldRetry(error)
    }), { enabled: dedupe, id: requestId });
  };
}
function shouldRetry(error) {
  if (isAbortError(error))
    return false;
  if ("code" in error && typeof error.code === "number") {
    if (error.code === -1)
      return true;
    if (error.code === LimitExceededRpcError.code)
      return true;
    if (error.code === InternalRpcError.code)
      return true;
    if (error.code === 429)
      return true;
    if (error.code === -32007)
      return true;
    return false;
  }
  if (error instanceof HttpRequestError && error.status) {
    if (error.status === 403)
      return true;
    if (error.status === 408)
      return true;
    if (error.status === 413)
      return true;
    if (error.status === 429)
      return true;
    if (error.status === 500)
      return true;
    if (error.status === 502)
      return true;
    if (error.status === 503)
      return true;
    if (error.status === 504)
      return true;
    return false;
  }
  return true;
}
function hashString(str, seed = 0) {
  let h1 = 3735928559 ^ seed;
  let h2 = 1103547991 ^ seed;
  for (let i = 0;i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
  h1 ^= Math.imul(h2 ^ h2 >>> 16, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
  h2 ^= Math.imul(h1 ^ h1 >>> 16, 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// node_modules/viem/_esm/clients/transports/createTransport.js
function createTransport({ key, methods, name, request, retryCount = 3, retryDelay = 150, timeout, type }, value) {
  const uid2 = uid();
  return {
    config: {
      key,
      methods,
      name,
      request,
      retryCount,
      retryDelay,
      timeout,
      type
    },
    request: buildRequest(request, { methods, retryCount, retryDelay, uid: uid2 }),
    value
  };
}

// node_modules/viem/_esm/clients/transports/http.js
var signalId = 0;
var signalIds = new WeakMap;
function getSignalId(signal) {
  if (!signal)
    return "default";
  const id = signalIds.get(signal);
  if (id !== undefined)
    return id;
  const nextId = signalId++;
  signalIds.set(signal, nextId);
  return nextId;
}
function http(url, config = {}) {
  const { batch, fetchFn, fetchOptions, key = "http", maxResponseBodySize, methods, name = "HTTP JSON-RPC", onFetchRequest, onFetchResponse, retryDelay, raw } = config;
  return ({ chain, retryCount: retryCount_, timeout: timeout_ }) => {
    const { batchSize = 1000, wait: wait2 = 0 } = typeof batch === "object" ? batch : {};
    const retryCount = config.retryCount ?? retryCount_;
    const timeout = timeout_ ?? config.timeout ?? 1e4;
    const url_ = url || chain?.rpcUrls.default.http[0];
    if (!url_)
      throw new UrlRequiredError;
    const rpcClient = getHttpRpcClient(url_, {
      fetchFn,
      fetchOptions,
      maxResponseBodySize,
      onRequest: onFetchRequest,
      onResponse: onFetchResponse,
      timeout
    });
    return createTransport({
      key,
      methods,
      name,
      async request({ method, params }, options) {
        const body = { method, params };
        const fetchOptions2 = options?.signal ? { signal: options.signal } : undefined;
        const { schedule } = createBatchScheduler({
          id: `${url_}.${getSignalId(options?.signal)}`,
          wait: wait2,
          shouldSplitBatch(requests) {
            return requests.length > batchSize;
          },
          fn: (body2) => rpcClient.request({
            body: body2,
            fetchOptions: fetchOptions2
          }),
          sort: (a, b) => a.id - b.id
        });
        const fn = async (body2) => batch ? schedule(body2) : [
          await rpcClient.request({
            body: body2,
            fetchOptions: fetchOptions2
          })
        ];
        const [{ error, result }] = await fn(body);
        if (raw)
          return { error, result };
        if (error)
          throw new RpcRequestError({
            body,
            error,
            url: url_
          });
        return result;
      },
      retryCount,
      retryDelay,
      timeout,
      type: "http"
    }, {
      fetchOptions,
      url: url_
    });
  };
}
// node_modules/viem/_esm/utils/abi/parseEventLogs.js
init_isAddressEqual();
init_toBytes();

// node_modules/viem/_esm/utils/formatters/log.js
function formatLog(log, { args, eventName } = {}) {
  return {
    ...log,
    blockHash: log.blockHash ? log.blockHash : null,
    blockNumber: log.blockNumber ? BigInt(log.blockNumber) : null,
    blockTimestamp: log.blockTimestamp ? BigInt(log.blockTimestamp) : log.blockTimestamp === null ? null : undefined,
    logIndex: log.logIndex ? Number(log.logIndex) : null,
    transactionHash: log.transactionHash ? log.transactionHash : null,
    transactionIndex: log.transactionIndex ? Number(log.transactionIndex) : null,
    ...eventName ? { args, eventName } : {}
  };
}

// node_modules/viem/_esm/utils/abi/parseEventLogs.js
init_keccak256();
init_toEventSelector();

// node_modules/viem/_esm/utils/abi/decodeEventLog.js
init_abi();
init_cursor();
init_size();
init_toEventSelector();
init_decodeAbiParameters();
init_formatAbiItem2();
var docsPath = "/docs/contract/decodeEventLog";
function decodeEventLog(parameters) {
  const { abi, data, strict: strict_, topics } = parameters;
  const strict = strict_ ?? true;
  const [signature, ...argTopics] = topics;
  if (!signature)
    throw new AbiEventSignatureEmptyTopicsError({ docsPath });
  const abiItem = abi.find((x) => x.type === "event" && signature === toEventSelector(formatAbiItem2(x)));
  if (!(abiItem && ("name" in abiItem)) || abiItem.type !== "event")
    throw new AbiEventSignatureNotFoundError(signature, { docsPath });
  const { name, inputs } = abiItem;
  const isUnnamed = inputs?.some((x) => !(("name" in x) && x.name));
  const args = isUnnamed ? [] : {};
  const indexedInputs = inputs.map((x, i) => [x, i]).filter(([x]) => ("indexed" in x) && x.indexed);
  const missingIndexedInputs = [];
  for (let i = 0;i < indexedInputs.length; i++) {
    const [param, argIndex] = indexedInputs[i];
    const topic = argTopics[i];
    if (!topic) {
      if (strict)
        throw new DecodeLogTopicsMismatch({
          abiItem,
          param
        });
      missingIndexedInputs.push([param, argIndex]);
      continue;
    }
    args[isUnnamed ? argIndex : param.name || argIndex] = decodeTopic({
      param,
      value: topic
    });
  }
  const nonIndexedInputs = inputs.filter((x) => !(("indexed" in x) && x.indexed));
  const inputsToDecode = strict ? nonIndexedInputs : [...missingIndexedInputs.map(([param]) => param), ...nonIndexedInputs];
  if (inputsToDecode.length > 0) {
    if (data && data !== "0x") {
      try {
        const decodedData = decodeAbiParameters(inputsToDecode, data);
        if (decodedData) {
          let dataIndex = 0;
          if (!strict) {
            for (const [param, argIndex] of missingIndexedInputs) {
              args[isUnnamed ? argIndex : param.name || argIndex] = decodedData[dataIndex++];
            }
          }
          if (isUnnamed) {
            for (let i = 0;i < inputs.length; i++)
              if (args[i] === undefined && dataIndex < decodedData.length)
                args[i] = decodedData[dataIndex++];
          } else
            for (let i = 0;i < nonIndexedInputs.length; i++)
              args[nonIndexedInputs[i].name] = decodedData[dataIndex++];
        }
      } catch (err) {
        if (strict) {
          if (err instanceof AbiDecodingDataSizeTooSmallError || err instanceof PositionOutOfBoundsError)
            throw new DecodeLogDataMismatch({
              abiItem,
              data,
              params: inputsToDecode,
              size: size2(data)
            });
          throw err;
        }
      }
    } else if (strict) {
      throw new DecodeLogDataMismatch({
        abiItem,
        data: "0x",
        params: inputsToDecode,
        size: 0
      });
    }
  }
  return {
    eventName: name,
    args: Object.values(args).length > 0 ? args : undefined
  };
}
function decodeTopic({ param, value }) {
  if (param.type === "string" || param.type === "bytes" || param.type === "tuple" || param.type.match(/^(.*)\[(\d+)?\]$/))
    return value;
  const decodedArg = decodeAbiParameters([param], value) || [];
  return decodedArg[0];
}

// node_modules/viem/_esm/utils/abi/parseEventLogs.js
function parseEventLogs(parameters) {
  const { abi, args, logs, strict = true } = parameters;
  const eventName = (() => {
    if (!parameters.eventName)
      return;
    if (Array.isArray(parameters.eventName))
      return parameters.eventName;
    return [parameters.eventName];
  })();
  const abiTopics = abi.filter((abiItem) => abiItem.type === "event").map((abiItem) => ({
    abi: abiItem,
    selector: toEventSelector(abiItem)
  }));
  return logs.map((log) => {
    const formattedLog = typeof log.blockNumber === "string" ? formatLog(log) : log;
    const abiItems = abiTopics.filter((abiTopic) => formattedLog.topics[0] === abiTopic.selector);
    if (abiItems.length === 0)
      return null;
    let event;
    let abiItem;
    for (const item of abiItems) {
      try {
        event = decodeEventLog({
          ...formattedLog,
          abi: [item.abi],
          strict: true
        });
        abiItem = item;
        break;
      } catch {}
    }
    if (!event && !strict) {
      abiItem = abiItems[0];
      try {
        event = decodeEventLog({
          data: formattedLog.data,
          topics: formattedLog.topics,
          abi: [abiItem.abi],
          strict: false
        });
      } catch {
        const isUnnamed = abiItem.abi.inputs?.some((x) => !(("name" in x) && x.name));
        return {
          ...formattedLog,
          args: isUnnamed ? [] : {},
          eventName: abiItem.abi.name
        };
      }
    }
    if (!event || !abiItem)
      return null;
    if (eventName && !eventName.includes(event.eventName))
      return null;
    if (!includesArgs({
      args: event.args,
      inputs: abiItem.abi.inputs,
      matchArgs: args
    }))
      return null;
    return { ...event, ...formattedLog };
  }).filter(Boolean);
}
function includesArgs(parameters) {
  const { args, inputs, matchArgs } = parameters;
  if (!matchArgs)
    return true;
  if (!args)
    return false;
  function isEqual(input, value, arg) {
    try {
      if (input.type === "address")
        return isAddressEqual(value, arg);
      if (input.type === "string" || input.type === "bytes")
        return keccak256(toBytes(value)) === arg;
      return value === arg;
    } catch {
      return false;
    }
  }
  if (Array.isArray(args) && Array.isArray(matchArgs)) {
    return matchArgs.every((value, index2) => {
      if (value === null || value === undefined)
        return true;
      const input = inputs[index2];
      if (!input)
        return false;
      const value_ = Array.isArray(value) ? value : [value];
      return value_.some((value2) => isEqual(input, value2, args[index2]));
    });
  }
  if (typeof args === "object" && !Array.isArray(args) && typeof matchArgs === "object" && !Array.isArray(matchArgs))
    return Object.entries(matchArgs).every(([key, value]) => {
      if (value === null || value === undefined)
        return true;
      const input = inputs.find((input2) => input2.name === key);
      if (!input)
        return false;
      const value_ = Array.isArray(value) ? value : [value];
      return value_.some((value2) => isEqual(input, value2, args[key]));
    });
  return false;
}
// node_modules/viem/_esm/utils/chain/defineChain.js
function defineChain(chain) {
  const chainInstance = {
    formatters: undefined,
    fees: undefined,
    serializers: undefined,
    ...chain
  };
  function extend(base) {
    return (fnOrExtended) => {
      const properties = typeof fnOrExtended === "function" ? fnOrExtended(base) : fnOrExtended;
      const combined = { ...base, ...properties };
      return Object.assign(combined, { extend: extend(combined) });
    };
  }
  return Object.assign(chainInstance, {
    extend: extend(chainInstance)
  });
}

// node_modules/viem/_esm/index.js
init_toBytes();
init_keccak256();
// node_modules/viem/_esm/actions/public/readContract.js
init_decodeFunctionResult();
init_encodeFunctionData();

// node_modules/viem/_esm/utils/errors/getContractError.js
init_abi();
init_base();
init_contract();
init_request();
init_rpc();
var EXECUTION_REVERTED_ERROR_CODE = 3;
function getContractError2(err, { abi, address, args, docsPath: docsPath4, functionName, sender }) {
  const error = err instanceof RawContractError2 ? err : err instanceof BaseError3 ? err.walk((err2) => typeof err2 === "object" && err2 !== null && ("data" in err2)) || err.walk() : {};
  const { code, data, details, message, shortMessage } = error;
  const cause = (() => {
    if (err instanceof AbiDecodingZeroDataError)
      return new ContractFunctionZeroDataError2({ functionName, cause: err });
    if ([EXECUTION_REVERTED_ERROR_CODE, InternalRpcError.code].includes(code) && (data || details || message || shortMessage) || code === InvalidInputRpcError.code && details === "execution reverted" && data) {
      return new ContractFunctionRevertedError2({
        abi,
        data: typeof data === "object" ? data.data : data,
        functionName,
        message: error instanceof RpcRequestError ? details : shortMessage ?? message,
        cause: err
      });
    }
    return err;
  })();
  return new ContractFunctionExecutionError2(cause, {
    abi,
    args,
    contractAddress: address,
    docsPath: docsPath4,
    functionName,
    sender
  });
}

// node_modules/viem/_esm/utils/getAction.js
function getAction(client, actionFn, name) {
  const action_implicit = client[actionFn.name];
  if (typeof action_implicit === "function")
    return action_implicit;
  const action_explicit = client[name];
  if (typeof action_explicit === "function")
    return action_explicit;
  return (params) => actionFn(client, params);
}

// node_modules/viem/_esm/actions/public/readContract.js
init_call();
async function readContract(client, parameters) {
  const { abi, address, args, functionName, ...rest } = parameters;
  const calldata = encodeFunctionData2({
    abi,
    args,
    functionName
  });
  try {
    const { data } = await getAction(client, call, "call")({
      ...rest,
      data: calldata,
      to: address
    });
    return decodeFunctionResult2({
      abi,
      args,
      functionName,
      data: data || "0x"
    });
  } catch (error) {
    throw getContractError2(error, {
      abi,
      address,
      args,
      docsPath: "/docs/contract/readContract",
      functionName
    });
  }
}
// node_modules/viem/_esm/actions/public/simulateContract.js
init_decodeFunctionResult();
init_encodeFunctionData();
init_call();
async function simulateContract(client, parameters) {
  const { abi, address, args, functionName, dataSuffix = typeof client.dataSuffix === "string" ? client.dataSuffix : client.dataSuffix?.value, ...callRequest } = parameters;
  const account = callRequest.account ? parseAccount(callRequest.account) : client.account;
  const calldata = encodeFunctionData2({ abi, args, functionName });
  try {
    const { data } = await getAction(client, call, "call")({
      batch: false,
      data: `${calldata}${dataSuffix ? dataSuffix.replace("0x", "") : ""}`,
      to: address,
      ...callRequest,
      account
    });
    const result = decodeFunctionResult2({
      abi,
      args,
      functionName,
      data: data || "0x"
    });
    const minimizedAbi = abi.filter((abiItem) => ("name" in abiItem) && abiItem.name === parameters.functionName);
    return {
      result,
      request: {
        abi: minimizedAbi,
        address,
        args,
        dataSuffix,
        functionName,
        ...callRequest,
        account
      }
    };
  } catch (error) {
    throw getContractError2(error, {
      abi,
      address,
      args,
      docsPath: "/docs/contract/simulateContract",
      functionName,
      sender: account?.address
    });
  }
}
// node_modules/viem/_esm/errors/block.js
init_base();

class BlockNotFoundError2 extends BaseError3 {
  constructor({ blockHash, blockNumber }) {
    let identifier = "Block";
    if (blockHash)
      identifier = `Block at hash "${blockHash}"`;
    if (blockNumber)
      identifier = `Block at number "${blockNumber}"`;
    super(`${identifier} could not be found.`, { name: "BlockNotFoundError" });
  }
}

// node_modules/viem/_esm/actions/public/waitForTransactionReceipt.js
init_transaction();

// node_modules/viem/_esm/utils/observe.js
var listenersCache = /* @__PURE__ */ new Map;
var cleanupCache = /* @__PURE__ */ new Map;
var callbackCount = 0;
function observe(observerId, callbacks, fn) {
  const callbackId = ++callbackCount;
  const getListeners = () => listenersCache.get(observerId) || [];
  const unsubscribe = () => {
    const listeners2 = getListeners();
    const nextListeners = listeners2.filter((cb) => cb.id !== callbackId);
    if (nextListeners.length === 0) {
      listenersCache.delete(observerId);
      cleanupCache.delete(observerId);
      return;
    }
    listenersCache.set(observerId, nextListeners);
  };
  const unwatch = () => {
    const listeners2 = getListeners();
    if (!listeners2.some((cb) => cb.id === callbackId))
      return;
    const cleanup2 = cleanupCache.get(observerId);
    if (listeners2.length === 1 && cleanup2) {
      const p = cleanup2();
      if (p instanceof Promise)
        p.catch(() => {});
    }
    unsubscribe();
  };
  const listeners = getListeners();
  listenersCache.set(observerId, [
    ...listeners,
    { id: callbackId, fns: callbacks }
  ]);
  if (listeners && listeners.length > 0)
    return unwatch;
  const emit = {};
  for (const key in callbacks) {
    emit[key] = (...args) => {
      const listeners2 = getListeners();
      if (listeners2.length === 0)
        return;
      for (const listener of listeners2)
        listener.fns[key]?.(...args);
    };
  }
  const cleanup = fn(emit);
  if (typeof cleanup === "function")
    cleanupCache.set(observerId, cleanup);
  return unwatch;
}
// node_modules/viem/_esm/actions/public/getBlock.js
init_toHex();

// node_modules/viem/_esm/utils/formatters/transaction.js
init_fromHex();
var transactionType2 = {
  "0x0": "legacy",
  "0x1": "eip2930",
  "0x2": "eip1559",
  "0x3": "eip4844",
  "0x4": "eip7702"
};
function formatTransaction2(transaction, _) {
  const transaction_ = {
    ...transaction,
    blockHash: transaction.blockHash ? transaction.blockHash : null,
    blockNumber: transaction.blockNumber ? BigInt(transaction.blockNumber) : null,
    ...transaction.blockTimestamp != null && {
      blockTimestamp: BigInt(transaction.blockTimestamp)
    },
    chainId: transaction.chainId ? hexToNumber(transaction.chainId) : undefined,
    gas: transaction.gas ? BigInt(transaction.gas) : undefined,
    gasPrice: transaction.gasPrice ? BigInt(transaction.gasPrice) : undefined,
    maxFeePerBlobGas: transaction.maxFeePerBlobGas ? BigInt(transaction.maxFeePerBlobGas) : undefined,
    maxFeePerGas: transaction.maxFeePerGas ? BigInt(transaction.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ? BigInt(transaction.maxPriorityFeePerGas) : undefined,
    nonce: transaction.nonce ? hexToNumber(transaction.nonce) : undefined,
    to: transaction.to ? transaction.to : null,
    transactionIndex: transaction.transactionIndex ? Number(transaction.transactionIndex) : null,
    type: transaction.type ? transactionType2[transaction.type] : undefined,
    typeHex: transaction.type ? transaction.type : undefined,
    value: transaction.value ? BigInt(transaction.value) : undefined,
    v: transaction.v ? BigInt(transaction.v) : undefined
  };
  if (transaction.authorizationList)
    transaction_.authorizationList = formatAuthorizationList2(transaction.authorizationList);
  transaction_.yParity = (() => {
    if (transaction.yParity)
      return Number(transaction.yParity);
    if (typeof transaction_.v === "bigint") {
      if (transaction_.v === 0n || transaction_.v === 27n)
        return 0;
      if (transaction_.v === 1n || transaction_.v === 28n)
        return 1;
      if (transaction_.v >= 35n)
        return transaction_.v % 2n === 0n ? 1 : 0;
    }
    return;
  })();
  if (transaction_.type === "legacy") {
    delete transaction_.accessList;
    delete transaction_.maxFeePerBlobGas;
    delete transaction_.maxFeePerGas;
    delete transaction_.maxPriorityFeePerGas;
    delete transaction_.yParity;
  }
  if (transaction_.type === "eip2930") {
    delete transaction_.maxFeePerBlobGas;
    delete transaction_.maxFeePerGas;
    delete transaction_.maxPriorityFeePerGas;
  }
  if (transaction_.type === "eip1559")
    delete transaction_.maxFeePerBlobGas;
  return transaction_;
}
function formatAuthorizationList2(authorizationList) {
  return authorizationList.map((authorization) => ({
    address: authorization.address,
    chainId: Number(authorization.chainId),
    nonce: Number(authorization.nonce),
    r: authorization.r,
    s: authorization.s,
    yParity: Number(authorization.yParity)
  }));
}

// node_modules/viem/_esm/utils/formatters/block.js
function formatBlock2(block, _) {
  const transactions = (block.transactions ?? []).map((transaction) => {
    if (typeof transaction === "string")
      return transaction;
    return formatTransaction2(transaction);
  });
  return {
    ...block,
    baseFeePerGas: block.baseFeePerGas ? BigInt(block.baseFeePerGas) : null,
    blobGasUsed: block.blobGasUsed ? BigInt(block.blobGasUsed) : undefined,
    difficulty: block.difficulty ? BigInt(block.difficulty) : undefined,
    excessBlobGas: block.excessBlobGas ? BigInt(block.excessBlobGas) : undefined,
    gasLimit: block.gasLimit ? BigInt(block.gasLimit) : undefined,
    gasUsed: block.gasUsed ? BigInt(block.gasUsed) : undefined,
    hash: block.hash ? block.hash : null,
    logsBloom: block.logsBloom ? block.logsBloom : null,
    nonce: block.nonce ? block.nonce : null,
    number: block.number ? BigInt(block.number) : null,
    size: block.size ? BigInt(block.size) : undefined,
    timestamp: block.timestamp ? BigInt(block.timestamp) : undefined,
    transactions,
    totalDifficulty: block.totalDifficulty ? BigInt(block.totalDifficulty) : null
  };
}

// node_modules/viem/_esm/actions/public/getBlock.js
async function getBlock(client, { blockHash, blockNumber, blockTag = client.experimental_blockTag ?? "latest", includeTransactions: includeTransactions_ } = {}) {
  const includeTransactions = includeTransactions_ ?? false;
  const blockNumberHex = blockNumber !== undefined ? numberToHex(blockNumber) : undefined;
  let block = null;
  if (blockHash) {
    block = await client.request({
      method: "eth_getBlockByHash",
      params: [blockHash, includeTransactions]
    }, { dedupe: true });
  } else {
    block = await client.request({
      method: "eth_getBlockByNumber",
      params: [blockNumberHex || blockTag, includeTransactions]
    }, { dedupe: Boolean(blockNumberHex) });
  }
  if (!block)
    throw new BlockNotFoundError2({ blockHash, blockNumber });
  const format2 = client.chain?.formatters?.block?.format || formatBlock2;
  return format2(block, "getBlock");
}

// node_modules/viem/_esm/actions/public/getTransaction.js
init_transaction();
init_toHex();
async function getTransaction(client, { blockHash, blockNumber, blockTag: blockTag_, hash: hash2, index: index2, sender, nonce }) {
  const blockTag = blockTag_ || "latest";
  const blockNumberHex = blockNumber !== undefined ? numberToHex(blockNumber) : undefined;
  let transaction = null;
  if (hash2) {
    transaction = await client.request({
      method: "eth_getTransactionByHash",
      params: [hash2]
    }, { dedupe: true });
  } else if (blockHash) {
    transaction = await client.request({
      method: "eth_getTransactionByBlockHashAndIndex",
      params: [blockHash, numberToHex(index2)]
    }, { dedupe: true });
  } else if ((blockNumberHex || blockTag) && typeof index2 === "number") {
    transaction = await client.request({
      method: "eth_getTransactionByBlockNumberAndIndex",
      params: [blockNumberHex || blockTag, numberToHex(index2)]
    }, { dedupe: Boolean(blockNumberHex) });
  } else if (sender && typeof nonce === "number") {
    transaction = await client.request({
      method: "eth_getTransactionBySenderAndNonce",
      params: [sender, numberToHex(nonce)]
    }, { dedupe: true });
  }
  if (!transaction)
    throw new TransactionNotFoundError2({
      blockHash,
      blockNumber,
      blockTag,
      hash: hash2,
      index: index2
    });
  const format2 = client.chain?.formatters?.transaction?.format || formatTransaction2;
  return format2(transaction, "getTransaction");
}

// node_modules/viem/_esm/actions/public/getTransactionReceipt.js
init_transaction();

// node_modules/viem/_esm/utils/formatters/transactionReceipt.js
init_fromHex();
var receiptStatuses = {
  "0x0": "reverted",
  "0x1": "success"
};
function formatTransactionReceipt2(transactionReceipt, _) {
  const receipt = {
    ...transactionReceipt,
    blockNumber: transactionReceipt.blockNumber ? BigInt(transactionReceipt.blockNumber) : null,
    contractAddress: transactionReceipt.contractAddress ? transactionReceipt.contractAddress : null,
    cumulativeGasUsed: transactionReceipt.cumulativeGasUsed ? BigInt(transactionReceipt.cumulativeGasUsed) : null,
    effectiveGasPrice: transactionReceipt.effectiveGasPrice ? BigInt(transactionReceipt.effectiveGasPrice) : null,
    gasUsed: transactionReceipt.gasUsed ? BigInt(transactionReceipt.gasUsed) : null,
    logs: transactionReceipt.logs ? transactionReceipt.logs.map((log) => formatLog(log)) : null,
    to: transactionReceipt.to ? transactionReceipt.to : null,
    transactionIndex: transactionReceipt.transactionIndex ? hexToNumber(transactionReceipt.transactionIndex) : null,
    status: transactionReceipt.status ? receiptStatuses[transactionReceipt.status] : null,
    type: transactionReceipt.type ? transactionType2[transactionReceipt.type] || transactionReceipt.type : null
  };
  if (transactionReceipt.blobGasPrice)
    receipt.blobGasPrice = BigInt(transactionReceipt.blobGasPrice);
  if (transactionReceipt.blobGasUsed)
    receipt.blobGasUsed = BigInt(transactionReceipt.blobGasUsed);
  return receipt;
}

// node_modules/viem/_esm/actions/public/getTransactionReceipt.js
async function getTransactionReceipt(client, { hash: hash2 }) {
  const receipt = await client.request({
    method: "eth_getTransactionReceipt",
    params: [hash2]
  }, { dedupe: true });
  if (!receipt)
    throw new TransactionReceiptNotFoundError2({ hash: hash2 });
  const format2 = client.chain?.formatters?.transactionReceipt?.format || formatTransactionReceipt2;
  return format2(receipt, "getTransactionReceipt");
}

// node_modules/viem/_esm/actions/public/watchBlockNumber.js
init_fromHex();

// node_modules/viem/_esm/utils/poll.js
function poll(fn, { emitOnBegin, initialWaitTime, interval }) {
  let active = true;
  const unwatch = () => active = false;
  const watch = async () => {
    let data;
    if (emitOnBegin)
      data = await fn({ unpoll: unwatch });
    const initialWait = await initialWaitTime?.(data) ?? interval;
    await wait(initialWait);
    const poll2 = async () => {
      if (!active)
        return;
      await fn({ unpoll: unwatch });
      await wait(interval);
      poll2();
    };
    poll2();
  };
  watch();
  return unwatch;
}
// node_modules/viem/_esm/utils/promise/withCache.js
var promiseCache2 = /* @__PURE__ */ new Map;
var responseCache = /* @__PURE__ */ new Map;
function getCache(cacheKey) {
  const buildCache = (cacheKey2, cache) => ({
    clear: () => cache.delete(cacheKey2),
    get: () => cache.get(cacheKey2),
    set: (data) => cache.set(cacheKey2, data)
  });
  const promise = buildCache(cacheKey, promiseCache2);
  const response = buildCache(cacheKey, responseCache);
  return {
    clear: () => {
      promise.clear();
      response.clear();
    },
    promise,
    response
  };
}
async function withCache2(fn, { cacheKey, cacheTime = Number.POSITIVE_INFINITY }) {
  const cache = getCache(cacheKey);
  const response = cache.response.get();
  if (response && cacheTime > 0) {
    const age = Date.now() - response.created.getTime();
    if (age < cacheTime)
      return response.data;
  }
  let promise = cache.promise.get();
  if (!promise) {
    promise = fn();
    cache.promise.set(promise);
  }
  try {
    const data = await promise;
    cache.response.set({ created: new Date, data });
    return data;
  } finally {
    cache.promise.clear();
  }
}

// node_modules/viem/_esm/actions/public/getBlockNumber.js
var cacheKey = (id) => `blockNumber.${id}`;
async function getBlockNumber(client, { cacheTime = client.cacheTime } = {}) {
  const blockNumberHex = await withCache2(() => client.request({
    method: "eth_blockNumber"
  }), { cacheKey: cacheKey(client.uid), cacheTime });
  return BigInt(blockNumberHex);
}

// node_modules/viem/_esm/actions/public/watchBlockNumber.js
function watchBlockNumber(client, { emitOnBegin = false, emitMissed = false, onBlockNumber, onError, poll: poll_, pollingInterval = client.pollingInterval }) {
  const enablePolling = (() => {
    if (typeof poll_ !== "undefined")
      return poll_;
    if (client.transport.type === "webSocket" || client.transport.type === "ipc")
      return false;
    if (client.transport.type === "fallback" && (client.transport.transports[0].config.type === "webSocket" || client.transport.transports[0].config.type === "ipc"))
      return false;
    return true;
  })();
  let prevBlockNumber;
  const pollBlockNumber = () => {
    const observerId = stringify([
      "watchBlockNumber",
      client.uid,
      emitOnBegin,
      emitMissed,
      pollingInterval
    ]);
    return observe(observerId, { onBlockNumber, onError }, (emit) => poll(async () => {
      try {
        const blockNumber = await getAction(client, getBlockNumber, "getBlockNumber")({ cacheTime: 0 });
        if (prevBlockNumber !== undefined) {
          if (blockNumber === prevBlockNumber)
            return;
          if (blockNumber - prevBlockNumber > 1 && emitMissed) {
            for (let i = prevBlockNumber + 1n;i < blockNumber; i++) {
              emit.onBlockNumber(i, prevBlockNumber);
              prevBlockNumber = i;
            }
          }
        }
        if (prevBlockNumber === undefined || blockNumber > prevBlockNumber) {
          emit.onBlockNumber(blockNumber, prevBlockNumber);
          prevBlockNumber = blockNumber;
        }
      } catch (err) {
        emit.onError?.(err);
      }
    }, {
      emitOnBegin,
      interval: pollingInterval
    }));
  };
  const subscribeBlockNumber = () => {
    const observerId = stringify([
      "watchBlockNumber",
      client.uid,
      emitOnBegin,
      emitMissed
    ]);
    return observe(observerId, { onBlockNumber, onError }, (emit) => {
      let active = true;
      let unsubscribe = () => active = false;
      (async () => {
        try {
          const transport = (() => {
            if (client.transport.type === "fallback") {
              const transport2 = client.transport.transports.find((transport3) => transport3.config.type === "webSocket" || transport3.config.type === "ipc");
              if (!transport2)
                return client.transport;
              return transport2.value;
            }
            return client.transport;
          })();
          const { unsubscribe: unsubscribe_ } = await transport.subscribe({
            params: ["newHeads"],
            onData(data) {
              if (!active)
                return;
              const blockNumber = hexToBigInt(data.result?.number);
              emit.onBlockNumber(blockNumber, prevBlockNumber);
              prevBlockNumber = blockNumber;
            },
            onError(error) {
              emit.onError?.(error);
            }
          });
          unsubscribe = unsubscribe_;
          if (!active)
            unsubscribe();
        } catch (err) {
          onError?.(err);
        }
      })();
      return () => unsubscribe();
    });
  };
  return enablePolling ? pollBlockNumber() : subscribeBlockNumber();
}

// node_modules/viem/_esm/actions/public/waitForTransactionReceipt.js
async function waitForTransactionReceipt(client, parameters) {
  const {
    checkReplacement = client.chain?.supportsTransactionReplacementDetection ?? true,
    confirmations = 1,
    hash: hash2,
    onReplaced,
    retryCount = 6,
    retryDelay = ({ count }) => ~~(1 << count) * 200,
    timeout = 180000
  } = parameters;
  const pollingInterval = (() => {
    if (parameters.pollingInterval)
      return parameters.pollingInterval;
    if (client.chain?.experimental_preconfirmationTime)
      return client.chain.experimental_preconfirmationTime;
    return client.pollingInterval;
  })();
  const observerId = stringify([
    "waitForTransactionReceipt",
    client.uid,
    hash2,
    {
      checkReplacement,
      confirmations,
      pollingInterval,
      retryCount,
      timeout
    }
  ]);
  let transaction;
  let replacedTransaction;
  let receipt;
  let retrying = false;
  let _unobserve;
  let _unwatch;
  const { promise, resolve, reject } = withResolvers();
  const timer = timeout ? setTimeout(() => {
    _unwatch?.();
    _unobserve?.();
    reject(new WaitForTransactionReceiptTimeoutError2({ hash: hash2 }));
  }, timeout) : undefined;
  _unobserve = observe(observerId, { onReplaced, resolve, reject }, async (emit) => {
    receipt = await getAction(client, getTransactionReceipt, "getTransactionReceipt")({ hash: hash2 }).catch(() => {
      return;
    });
    if (receipt && confirmations <= 1) {
      clearTimeout(timer);
      emit.resolve(receipt);
      _unobserve?.();
      return;
    }
    _unwatch = getAction(client, watchBlockNumber, "watchBlockNumber")({
      emitMissed: true,
      emitOnBegin: true,
      poll: true,
      pollingInterval,
      async onBlockNumber(blockNumber_) {
        const done = (fn) => {
          clearTimeout(timer);
          _unwatch?.();
          fn();
          _unobserve?.();
        };
        let blockNumber = blockNumber_;
        if (retrying)
          return;
        try {
          if (receipt) {
            if (confirmations > 1 && (!receipt.blockNumber || blockNumber - receipt.blockNumber + 1n < confirmations))
              return;
            done(() => emit.resolve(receipt));
            return;
          }
          if (checkReplacement && !transaction) {
            retrying = true;
            await withRetry(async () => {
              transaction = await getAction(client, getTransaction, "getTransaction")({ hash: hash2 });
              if (transaction.blockNumber)
                blockNumber = transaction.blockNumber;
            }, {
              delay: retryDelay,
              retryCount
            });
            retrying = false;
          }
          receipt = await getAction(client, getTransactionReceipt, "getTransactionReceipt")({ hash: hash2 });
          if (confirmations > 1 && (!receipt.blockNumber || blockNumber - receipt.blockNumber + 1n < confirmations))
            return;
          done(() => emit.resolve(receipt));
        } catch (err) {
          if (err instanceof TransactionNotFoundError2 || err instanceof TransactionReceiptNotFoundError2) {
            if (!transaction) {
              retrying = false;
              return;
            }
            try {
              replacedTransaction = transaction;
              retrying = true;
              const block = await withRetry(() => getAction(client, getBlock, "getBlock")({
                blockNumber,
                includeTransactions: true
              }), {
                delay: retryDelay,
                retryCount,
                shouldRetry: ({ error }) => error instanceof BlockNotFoundError2
              });
              retrying = false;
              const replacementTransaction = block.transactions.find(({ from, hash: hash3, nonce }) => from === replacedTransaction.from && hash3 !== replacedTransaction.hash && nonce === replacedTransaction.nonce);
              if (!replacementTransaction)
                return;
              receipt = await getAction(client, getTransactionReceipt, "getTransactionReceipt")({
                hash: replacementTransaction.hash
              });
              if (confirmations > 1 && (!receipt.blockNumber || blockNumber - receipt.blockNumber + 1n < confirmations))
                return;
              let reason = "replaced";
              if (replacementTransaction.to === replacedTransaction.to && replacementTransaction.value === replacedTransaction.value && replacementTransaction.input === replacedTransaction.input) {
                reason = "repriced";
              } else if (replacementTransaction.from === replacementTransaction.to && replacementTransaction.value === 0n) {
                reason = "cancelled";
              }
              done(() => {
                emit.onReplaced?.({
                  reason,
                  replacedTransaction,
                  transaction: replacementTransaction,
                  transactionReceipt: receipt
                });
                emit.resolve(receipt);
              });
            } catch (err_) {
              done(() => emit.reject(err_));
            }
          } else {
            done(() => emit.reject(err));
          }
        }
      }
    });
  });
  return promise;
}
// sdk/trackrecord.ts
var MONAD_CHAIN_ID = 143;
var MONAD_RPC = "https://rpc.monad.xyz";
var EXPLORER = "https://monadscan.com";
var APP_URL = "https://chordsi.xyz";
var IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
var REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
var VALIDATION_REGISTRY = "0x695CAaeD3D15212F9eC6500992f373f09439F38d";
var TRACK_RECORD = "0xf5650FB475747e2766faDb46aef735F3Ee4e9f09";
var TRUST_GATE = "0xcB30174c3Bf5f8170fA6769fe6D704F55968412A";
var CHORD_VALIDATOR = "0x98C5d05f35Afb00B04781762c47a7676Af3056a4";
var AGENT_REGISTRY = `eip155:${MONAD_CHAIN_ID}:${IDENTITY_REGISTRY}`;
var REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
var DOC_TYPE = "chord-agent-fill/v1";
var ZERO_HEAD = `0x${"0".repeat(64)}`;
var monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC] } },
  blockExplorers: { default: { name: "Monadscan", url: EXPLORER } }
});
var identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
]);
var trustGateAbi = parseAbi([
  "function check(uint256 agentId) view returns (bool ok, uint64 fills, uint64 validations, uint8 avgScore, uint64 lastAt)"
]);
var trackRecordAbi = parseAbi([
  "function commit(uint256 agentId, bytes32 prevHead, bytes32[] fillHashes) returns (bytes32 head, uint64 count)",
  "function chains(uint256 agentId) view returns (bytes32 head, uint64 count, uint64 lastAt)",
  "event Committed(uint256 indexed agentId, uint64 indexed seq, bytes32 fillHash, bytes32 head)"
]);
var validationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)"
]);
function canonical(v) {
  if (v === null || v === undefined)
    return "null";
  if (typeof v === "number")
    return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string" || typeof v === "boolean")
    return JSON.stringify(v);
  if (Array.isArray(v))
    return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return "null";
}
var hashDoc = (text) => keccak256(toBytes(text));
function chainHead(hashes, from = ZERO_HEAD) {
  let head = from;
  for (const h of hashes)
    head = keccak256(`0x${head.slice(2)}${h.slice(2)}`);
  return head;
}
var idOf = (agentId) => {
  const s = String(agentId).trim();
  if (!/^\d+$/.test(s))
    throw new Error(`agent id must be a whole number, got "${s}"`);
  return BigInt(s);
};
var fetchOf = (opts) => opts.fetch ?? ((input, init) => fetch(input, init));
function rpcClient(opts = {}) {
  return createClient({ chain: monad, transport: http(opts.rpcUrl ?? MONAD_RPC, { fetchFn: opts.fetch, retryCount: 2 }) });
}
async function readChain(agentId, opts = {}) {
  const [head, count, lastAt] = await readContract(rpcClient(opts), { address: TRACK_RECORD, abi: trackRecordAbi, functionName: "chains", args: [idOf(agentId)] });
  return { head, count: Number(count), lastAt: Number(lastAt) * 1000 };
}
async function agentURI(agentId, opts = {}) {
  return readContract(rpcClient(opts), { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [idOf(agentId)] });
}
async function getJson(uri, opts) {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    const meta = uri.slice(5, comma), body = uri.slice(comma + 1);
    const text = meta.endsWith(";base64") ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body);
    return JSON.parse(text);
  }
  const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}` : uri.startsWith("ar://") ? `https://arweave.net/${uri.slice(5)}` : uri;
  const r = await fetchOf(opts)(url, { headers: { accept: "application/json" } });
  if (!r.ok)
    throw new Error(`${url} answered ${r.status}`);
  return r.json();
}
async function registration(agentId, opts = {}) {
  const uri = await agentURI(agentId, opts);
  if (!uri)
    throw new Error(`agent #${agentId} has no agentURI`);
  const reg = await getJson(uri, opts);
  if (!reg || typeof reg !== "object")
    throw new Error(`the registration file at ${uri} is not a JSON object`);
  const services = Array.isArray(reg.services) ? reg.services : Array.isArray(reg.endpoints) ? reg.endpoints : [];
  return { ...reg, services, uri };
}
async function fillsUrl(agentId, opts = {}) {
  const reg = await registration(agentId, opts);
  const s = reg.services.find((x) => String(x?.name ?? "").toLowerCase() === "track-record");
  if (!s?.endpoint)
    throw new Error(`agent #${agentId}: the registration file at ${reg.uri} has no "track-record" service`);
  return /^(https?|data|ipfs|ar):/.test(s.endpoint) ? s.endpoint : new URL(s.endpoint, reg.uri).toString();
}
var PAGE = 1000;
async function fetchFills(url, opts = {}) {
  const bySeq = new Map;
  let maxSeq = 0;
  const take = (body) => {
    const list = Array.isArray(body) ? body : Array.isArray(body?.fills) ? body.fills : [];
    const base = maxSeq;
    let added = 0;
    list.forEach((f, i) => {
      if (!f || f.doc == null)
        return;
      const seq = Number.isSafeInteger(f.seq) ? f.seq : base + i + 1;
      if (bySeq.has(seq))
        return;
      bySeq.set(seq, { ...f, seq, doc: typeof f.doc === "string" ? f.doc : canonical(f.doc) });
      maxSeq = Math.max(maxSeq, seq);
      added++;
    });
    return list.length === PAGE ? added : 0;
  };
  let more = take(await getJson(url, opts));
  for (let i = 0;more > 0 && i < 100; i++) {
    const next = new URL(url), from = maxSeq + 1;
    next.searchParams.set("from", String(from));
    next.searchParams.set("to", String(from + PAGE - 1));
    more = take(await getJson(next.toString(), opts));
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
async function verify(agentId, opts = {}) {
  const id = idOf(agentId).toString();
  const url = opts.fillsUrl ?? await fillsUrl(id, opts);
  const [onchain, fills] = await Promise.all([readChain(id, opts), fetchFills(url, opts)]);
  const bySeq = new Map(fills.map((f) => [f.seq, f]));
  const hashes = [], badHashes = [], missing = [];
  for (let seq = 1;seq <= onchain.count; seq++) {
    const f = bySeq.get(seq);
    if (!f) {
      missing.push(seq);
      continue;
    }
    const h = hashDoc(f.doc);
    if (typeof f.hash === "string" && f.hash.toLowerCase() !== h.toLowerCase())
      badHashes.push(seq);
    hashes.push(h);
  }
  const rebuiltHead = chainHead(hashes);
  const equal = !missing.length && rebuiltHead.toLowerCase() === onchain.head.toLowerCase();
  const ok = equal && onchain.count > 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const reason = onchain.count === 0 ? `agent #${id} has no fills on TrackRecord yet` : missing.length ? `${plural(missing.length, "committed document")} missing from ${url} (seq ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})` : !equal ? `rebuilt head ${rebuiltHead} differs from Monad's ${onchain.head}${badHashes.length ? `; document${badHashes.length === 1 ? "" : "s"} #${badHashes.slice(0, 5).join(", #")} do not hash to their listed hash` : ""}` : `${plural(onchain.count, "document")} rebuild the head Monad holds for agent #${id}${badHashes.length ? ` (the endpoint lists wrong hashes for #${badHashes.join(", #")})` : ""}`;
  return { ok, agentId: id, documents: hashes.length, badHashes, missing, rebuiltHead, onchain, fillsUrl: url, reason };
}
async function send(wallet, req, opts) {
  const account = wallet.account;
  if (!account)
    throw new Error("the wallet client has no account");
  const pc = rpcClient(opts);
  const { request } = await simulateContract(pc, { ...req, account });
  const tx = await wallet.writeContract({ ...request, account, chain: monad });
  const receipt = await waitForTransactionReceipt(pc, { hash: tx, timeout: 90000 });
  if (receipt.status !== "success")
    throw new Error(`transaction ${tx} reverted`);
  return { tx, block: Number(receipt.blockNumber), receipt };
}
var at = (addr) => (l) => l.address.toLowerCase() === addr.toLowerCase();
async function register(wallet, uri, opts = {}) {
  const s = await send(wallet, { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "register", args: [uri] }, opts);
  const ev = parseEventLogs({ abi: identityAbi, logs: s.receipt.logs, eventName: "Registered" }).find(at(IDENTITY_REGISTRY));
  if (!ev)
    throw new Error(`register ${s.tx}: no Registered event in the receipt`);
  return { ...s, agentId: ev.args.agentId.toString() };
}
async function commit(wallet, agentId, docs, opts = {}) {
  if (!docs.length)
    throw new Error("nothing to commit");
  const id = idOf(agentId);
  const prev = await readChain(id, opts);
  const hashes = docs.map(hashDoc);
  const s = await send(wallet, { address: TRACK_RECORD, abi: trackRecordAbi, functionName: "commit", args: [id, prev.head, hashes] }, opts);
  const committed = parseEventLogs({ abi: trackRecordAbi, logs: s.receipt.logs, eventName: "Committed" }).filter((l) => at(TRACK_RECORD)(l) && l.args.agentId === id).map((l) => ({ seq: Number(l.args.seq), fillHash: l.args.fillHash, head: l.args.head })).sort((a, b) => a.seq - b.seq);
  const head = chainHead(hashes, prev.head);
  const last = committed[committed.length - 1];
  if (!last || last.head.toLowerCase() !== head.toLowerCase())
    throw new Error(`commit ${s.tx}: the Committed events do not end at the expected head ${head}`);
  return { ...s, prevHead: prev.head, head, count: last.seq, committed };
}
async function requestValidation(wallet, p, opts = {}) {
  const s = await send(wallet, { address: VALIDATION_REGISTRY, abi: validationAbi, functionName: "validationRequest", args: [p.validator, idOf(p.agentId), p.requestURI, p.requestHash] }, opts);
  return { ...s, requestHash: p.requestHash };
}
async function setAgentURI(wallet, agentId, uri, opts = {}) {
  return send(wallet, { address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "setAgentURI", args: [idOf(agentId), uri] }, opts);
}
var hostOf = (o) => (o.host ?? APP_URL).replace(/\/$/, "");
async function publish(docs, o = {}) {
  const out = [];
  for (let i = 0;i < docs.length; i += 50) {
    const r = await (o.fetch ?? fetch)(`${hostOf(o)}/v1/trust/docs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docs: docs.slice(i, i + 50).map((d) => typeof d === "string" ? d : canonical(d)) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok)
      throw new Error(`publish: ${j.message ?? `HTTP ${r.status}`}`);
    out.push(...j.docs);
  }
  return out;
}
var hostedFillsUrl = (agentId, o = {}) => `${hostOf(o)}/v1/trust/onchain/${String(agentId)}/fills`;
async function askChordValidator(wallet, agentId, p = {}, opts = {}) {
  const chain = await readChain(agentId, opts);
  if (!chain.count)
    throw new Error("the agent has no committed fill yet");
  const request = canonical({
    type: "chord-agent-validation-request/v1",
    chainId: MONAD_CHAIN_ID,
    agentRegistry: AGENT_REGISTRY,
    agentId: String(agentId),
    trackRecord: TRACK_RECORD,
    range: { fromSeq: p.fromSeq ?? 1, toSeq: p.toSeq ?? chain.count },
    fills: hostedFillsUrl(agentId, p),
    createdAt: Date.now()
  });
  const [doc] = await publish([request], p);
  const sent = await requestValidation(wallet, { agentId, validator: CHORD_VALIDATOR, requestURI: doc.url, requestHash: doc.hash }, opts);
  await (p.fetch ?? fetch)(`${hostOf(p)}/v1/trust/validation/notify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tx: sent.tx }) }).catch(() => null);
  return { ...sent, requestURI: doc.url, reportURI: `${hostOf(p)}/v1/trust/validation/responses/${doc.hash}.json` };
}
async function gateCheck(agentId, opts = {}) {
  const [ok, fills, validations, avgScore, lastAt] = await readContract(rpcClient(opts), { address: TRUST_GATE, abi: trustGateAbi, functionName: "check", args: [idOf(agentId)] });
  return { ok, fills: Number(fills), validations: Number(validations), avgScore: Number(avgScore), lastAt: Number(lastAt) * 1000 };
}
function registrationFile(p) {
  const e = p.endpoints;
  const services = [
    ...e.web ? [{ name: "web", endpoint: e.web }] : [],
    ...e.api ? [{ name: "agent-api", endpoint: e.api }] : [],
    ...e.mcp ? [{ name: "MCP", endpoint: e.mcp }] : [],
    ...e.a2a ? [{ name: "A2A", endpoint: e.a2a }] : [],
    { name: "track-record", endpoint: e.trackRecord, version: p.docType ?? DOC_TYPE },
    ...p.services ?? []
  ];
  const agentId = p.agentId == null ? null : idOf(p.agentId).toString();
  return {
    type: REGISTRATION_TYPE,
    name: p.name,
    description: p.description,
    ...p.image ? { image: p.image } : {},
    services,
    x402Support: p.x402Support ?? false,
    active: p.active ?? true,
    registrations: agentId ? [{ agentId: Number(agentId), agentRegistry: AGENT_REGISTRY }] : [],
    supportedTrust: ["validation", "reputation"],
    trackRecord: { chainId: MONAD_CHAIN_ID, contract: TRACK_RECORD, agentId }
  };
}
export {
  verify,
  validationAbi,
  trustGateAbi,
  trackRecordAbi,
  setAgentURI,
  rpcClient,
  requestValidation,
  registrationFile,
  registration,
  register,
  readChain,
  publish,
  monad,
  identityAbi,
  hostedFillsUrl,
  hashDoc,
  gateCheck,
  fillsUrl,
  fetchFills,
  commit,
  chainHead,
  canonical,
  askChordValidator,
  agentURI,
  ZERO_HEAD,
  VALIDATION_REGISTRY,
  TRUST_GATE,
  TRACK_RECORD,
  REPUTATION_REGISTRY,
  REGISTRATION_TYPE,
  MONAD_RPC,
  MONAD_CHAIN_ID,
  IDENTITY_REGISTRY,
  EXPLORER,
  DOC_TYPE,
  CHORD_VALIDATOR,
  APP_URL,
  AGENT_REGISTRY
};
