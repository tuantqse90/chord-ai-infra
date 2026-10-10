// Custom bot builder, the strategy side (ask2049-notes/PROMPT-bot-builder.md): the Strategy v1 schema, the template gallery,
// words → strategy, plain-words explanation, the trigger sources the bots engine lacks, token snapshots for filters, the
// runner the engine plugs in as bot type "custom", and the backtest.
export {
  ACTION_TYPES, AddressSchema, EVERY_MS, FILTER_FIELDS, FILTER_OPS, LIMIT_DEFAULTS, LP_EVENTS, LP_MIN_USD_DEFAULT, PRICE_MINT_KEYWORDS, SAFETY_CHECKS, SCHEDULE_EVERY,
  StrategyInputError, StrategySchema, TRIGGER_TYPES, formatIssues, isFieldFilter, parseStrategy, strategyAddresses, validateStrategy,
  type Action, type Exits, type FieldFilter, type Filter, type FilterField, type Limits, type SafetyCheck, type SafetyFilter, type Strategy, type Trigger, type TriggerOf,
  type ValidateResult, type Wallets,
} from "./schema";
export { TEMPLATES, getTemplate, listTemplates, type Template } from "./templates";
export { SYSTEM_PROMPT, compileStrategy, extractJson, type CompileResult } from "./compile";
export { explainStrategy, filterText } from "./explain";
export {
  ConfluenceWindow, EdgeTrigger, PriceHistory, checkPrice, resolveWallets, scheduleDue, seedFromCandles, trendingMints,
  type ConfluenceHit, type PriceCheck,
} from "./sources";
export { _resetSnapshots, buildSnapshot, evaluateFilters, fieldsOf, type FilterVerdict, type TokenSnapshot } from "./snapshot";
export { createStrategyRunner, type FiredBy, type SkipRecord, type StrategyRunner, type StrategyRunnerDeps } from "./runner";
export { backtestStrategy, timeframeFor, type StrategyBacktest, type StrategyBacktestDeps } from "./backtest";
