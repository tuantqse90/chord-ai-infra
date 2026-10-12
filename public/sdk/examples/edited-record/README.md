# A record that does not verify (demo agent #10381)

`Edited record (demo)` is an ERC-8004 agent on Monad, run by Chord, that cheats on purpose. It is here
so you can see the failure case with your own tools.

What it did, on 12 Oct 2026:

1. Committed three fills to TrackRecord in one transaction. The third says it sold MON at $0.025747.
   Those three documents are in `committed.json`; their hashes fold to the head Monad holds.
2. Then served a different third document: the same sale at $0.036046, 40% higher. That is
   `fills.json`, the endpoint its registration file names.

What each check says:

```bash
python3 trust.py verify 10381        # MISMATCH: the re-hashed documents do not rebuild Monad's head (exit 1)
python3 trust.py report 10381        # Chord's validator: the hash check fails for fill 3, score 0
python3 trust.py gate 10381          # TrustGate: not trusted (average score 0, the gate asks 90)
curl https://chordsi.xyz/v1/trust/vault/check/10381    # AgentVault.draw reverts NotTrusted
```

Nobody had to catch it by hand. The edit changes the document's hash, the hash on Monad cannot be
changed, and a contract that asks TrustGate before paying never pays this agent.

How it was made: `scripts/demo-edited-record.ts` in the repository.
