// @limen/preflight (E-09): the transaction decoder, the pre-flight and the
// drain pattern, shared by the app and the server. Pure TypeScript: no React
// Native or Node imports; the network is reached only through the package's
// own JSON-RPC client, at the endpoint a caller gives.

export { decodeBase58, decodePublicKey, encodeBase58 } from "./base58.ts";
export { decodeBase64, encodeBase64 } from "./base64.ts";
export * from "./programs.ts";

export {
  parseTransaction,
  type CompiledInstruction,
  type LookupReference,
  type MessageHeader,
  type ParsedMessage,
  type ParsedTransaction,
  type ParseResult,
  type WireProblem,
} from "./wire.ts";
export {
  messageAccounts,
  type Account,
  type LookupTables,
} from "./accounts.ts";
export {
  decodeInstruction,
  type Decoded,
  type TokenProgram,
  type UndecodedReason,
} from "./decode.ts";
export {
  instructionVerdicts,
  summarizeTransaction,
  type Effect,
  type Place,
  type Signers,
  type TransactionSummary,
  type Undecoded,
} from "./summary.ts";
export {
  instructionEffect,
  PROGRAM_NAME,
  REFUSAL_WHY,
  type InstructionVerdict,
  type Refusal,
  type Verdict,
} from "./effect.ts";
export { type RunError } from "./failure.ts";
export {
  isJsonObject,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "./json.ts";
export { parseLookupTable } from "./state.ts";

// The package's only RPC is its own JSON-RPC client: a caller gives an
// endpoint (a URL and a fetch), never an RPC adapter of its own.
export {
  latestBlockhash,
  readAnswer,
  RPC_TIMEOUT_MS,
  withTimeout,
  type Fetch,
  type FetchResponse,
  type RpcEndpoint,
} from "./rpc.ts";
export { type BalanceChange } from "./simulate.ts";
export {
  forSigning,
  preflight,
  preflightTransaction,
  signBlocks,
  signingAllowed,
  toReport,
  type Preflight,
  type PreflightReport,
  type SignBlock,
  type SimulatedAt,
  type SimulationOutcome,
} from "./preflight.ts";
export {
  drainingChange,
  drainPattern,
  handsOverControl,
  SWEEP_DIVISOR,
} from "./drain.ts";
export {
  SCRUBBED,
  scrubAddresses,
  USER_MARKER,
  withMarker,
  withMarkers,
  withRoleMarkers,
} from "./marker.ts";
