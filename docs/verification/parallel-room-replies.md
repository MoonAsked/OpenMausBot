# Parallel replies in a group conversation

A group's response mode controls how multiple addressed members answer a chat
message. Existing and new groups default to **Sequential replies**. Select
**Parallel replies** in the group header or initial setup to let available
members start independently. The responder selection still controls who is
addressed: everyone, mentioned members, a chosen member, or automatic routing.
Goal coordination keeps its existing workflow.

Each member uses a separate group thread, with its own provider session,
approvals, cancellation and runtime ownership. All members receive the same
conversation snapshot for that round. A member that is busy elsewhere waits
without blocking other members. Each bot retains its existing occupancy lock;
shared computer access retains its existing resource arbitration.

The original conversation displays member progress and one reply per member in
roster order. Text streams into that reply. Open a member's details to review
tools or answer its approval, then use **Back to the original question** to
return. Details threads retain the original question and member identity.
Replies do not trigger another member merely by mentioning its name. Use
sequential mode when later members should read earlier members' answers.

Stop in the original conversation stops its current parallel round, including
members waiting to start, while leaving unrelated conversations alone. A member
failure is shown independently and does not discard successful replies.
If a member delegates work, the original conversation stays active and receives
that member's later summary after the delegated work returns. A follow-up sent
in a member's details addresses that member by default.

After a restart, incomplete parallel replies are marked interrupted and are
not automatically replayed. Saved text and details remain available for review
before continuing. The group keeps its chosen response mode.

## Verification

Follow `docs/verification/README.md`; all workflow mutations use disposable
homes and fake providers. Never send verification messages to the live app.

```sh
node node_modules/vitest/vitest.mjs run server/room-parallel-responders.e2e.test.ts
node node_modules/vitest/vitest.mjs run server/room-member-lock.test.ts server/room-parallel-threads.e2e.test.ts server/group-tasks.test.ts src/components/RoomResponseMode.test.ts
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p tsconfig.server.json
```

The parallel fixture checks actual overlapping fake-provider processes and
distinct member thread identities, scoped Stop, a busy first member, the shared
initial context, sequential fallback, isolated failure and streamed text across
multiple provider items. The renderer fixture in
`scripts/testing/parallel-room-ui.e2e.test.ts` drives the real group composer,
mode selector, member details and return navigation in a disposable browser.

These checks verify routing and UI behavior with simulated providers. They do
not establish availability or response quality of a user's connected engines.
