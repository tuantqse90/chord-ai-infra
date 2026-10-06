// ask2049: stand-in for Chord's packages/api/src/config/contracts.ts — only NULL_ROUTER_ABI, which services/ask/walletTools.ts
// reads to name the Chord router's entry points. Copied verbatim (2026-10-06); the rest of that file (tx chains, WMON) is not used here.

export const NULL_ROUTER_ABI = [
  {
    name: "swap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "route",
        type: "tuple",
        components: [
          { name: "adapter", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "extraData", type: "bytes" },
        ],
      },
      { name: "referrer", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "splitSwap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "adapter", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "extraData", type: "bytes" },
        ],
      },
      { name: "referrer", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multiHopSwap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "adapter", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "extraData", type: "bytes" },
        ],
      },
      { name: "referrer", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    // Native-output overload: unwrapOutput=true unwraps the final WMON hop to native MON.
    name: "multiHopSwap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "adapter", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "extraData", type: "bytes" },
        ],
      },
      { name: "referrer", type: "address" },
      { name: "unwrapOutput", type: "bool" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multiPathSwap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "paths",
        type: "tuple[]",
        components: [
          { name: "amountIn", type: "uint256" },
          {
            name: "hops",
            type: "tuple[]",
            components: [
              { name: "adapter", type: "address" },
              { name: "tokenIn", type: "address" },
              { name: "tokenOut", type: "address" },
              { name: "amountIn", type: "uint256" },
              { name: "extraData", type: "bytes" },
            ],
          },
        ],
      },
      { name: "referrer", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    // Native-output overload: unwrapOutput=true unwraps the final WMON output to native MON.
    name: "multiPathSwap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "paths",
        type: "tuple[]",
        components: [
          { name: "amountIn", type: "uint256" },
          {
            name: "hops",
            type: "tuple[]",
            components: [
              { name: "adapter", type: "address" },
              { name: "tokenIn", type: "address" },
              { name: "tokenOut", type: "address" },
              { name: "amountIn", type: "uint256" },
              { name: "extraData", type: "bytes" },
            ],
          },
        ],
      },
      { name: "referrer", type: "address" },
      { name: "unwrapOutput", type: "bool" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;
