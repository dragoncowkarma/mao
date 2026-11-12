# Store and recovery

Tier 3 reference — read when touching `core/store.ts`, `core/store-file.ts`, `core/persistence-guard.ts`, `electron/store.ts`, queue recovery in `core/app.ts`, the Sidebar's store cards, or a broken `config.json`. Rule summary: [AGENTS.md](../../../../AGENTS.md). Playbook: [SKILL.md](../SKILL.md).

`config.json` is the runtime store (`$MAO_DATA_DIR`, or Electron's `userData`), not a repo file. It
holds `githubToken` in plain text, so no report quotes it. Repo identity:
[repo-preflight-and-swarm.md](repo-preflight-and-swarm.md). Stages:
[workflow-and-routing.md](workflow-and-routing.md).

## Reads: coerce, report, never repair

- A declared type is an assertion: backends read unvalidated JSON and fill only *missing* keys, so
  every array field reads through `createStoredReadGuard()`.
- Coerce, never throw: `updateRepos` reads before writing, so a throwing read kills recovery.
- The guard never writes and is never silent: one stderr warning per field per store instance, never
  an entry, owner, repo, prompt, token or API key.
- `storedValueDefect()` is the only classifier: `'value'` (not an array), `'every-entry'` (nothing
  usable), `'some-entries'` (mixed), `null` (all usable, or `[]`). `report` takes its answer: a
  disagreement read as silence would lower the queue latch.

| Field | `usableEntry` | Array reads as (`readEntries`) | Halts? |
| --- | --- | --- | --- |
| `githubRepos` | `isRepoRef` | copy as stored | no |
| `aiProviders` | `isAiProviderConfig` | valid entries in order | no: no provider stops each stage before any GitHub write |
| `workflowTasks` | `isRestorableQueuedTask` | valid entries, normalized | yes, any defect |

A wrong container reads as a cloned default for every field.

- Report more than you correct, never the reverse. `githubRepos` stays unfiltered:
  `canonicalRepoList` owns the drop, and `mao repos list` and `mao config show` still show what the
  next write removes; the sidebar and `github:getRepos` show survivors only.
- `isRepoRef` is identity-only, matching the drop: a report no write clears never goes away. See the
  comment in `STORED_SHAPE_RULES`.
- Entry validation is structural. Credentials, known models and a stage's PR number stay with their
  owners.
- `MaoApp.saveProviders()` refuses while the raw list is unusable: the editor holds a filtered view,
  so saving deletes hidden entries and `apiKey`s. One valid provider left: the report warns about
  maker-checker.
- `get()` returns only the corrected value, so `problems()` carries the fact: evaluated now, never
  accumulated (IPC order must not decide what the operator is told), from raw values (the guard
  already substituted).
- `nothingUsable` is `defect !== 'some-entries'`, and `false` for a `wholeFile` problem, which has
  no `defect`.
- Never log or render a witness: stored content verbatim.

## Writes: refuse, never coerce

- `set()` throws and `setIfUnchanged()` returns `'invalid'` for an invalid
  `aiProviders`/`workflowTasks` list, before any backend read or write.
- `WorkflowEngine` runs `validateWrite()` on `[...queue, task]` before adopting it: a rejected
  enqueue cannot pollute memory or forge a marker.
- `describeInvalidStoredWrite` covers those two fields only: rejecting `githubRepos` entries would
  strand a store an older build wrote.

## When adding a store field

1. Add to `MaoStoreSchema` and `MAO_STORE_DEFAULTS` (`npm run lint` enforces the pair). Whole-file
   protection is inherited.
2. Array a hand edit can violate: add a `STORED_SHAPE_RULES` rule and a per-shape table test in
   `core/store.test.ts`; the compiler asks for neither. Arrays only: `storedValueDefect` answers
   `'value'` for any non-array, so a rule on a scalar reads every healthy value as defective. Read the
   JSDoc on `createStoredReadGuard`. Answer (cost and healing write go in the report message; a comment
   reaches no operator):
   - What does the fallback cost?
   - Which write heals it? Name the cheapest unconditional one: no preflight blocks it, no GitHub
     write.
   - Does losing it let unattended work start against state MAO cannot account for? Yes: add a
     latch. No: say so in a comment, like `describeUnusableProviderList`.
   - Does something downstream drop invalid entries? Yes: report and hand through, like
     `githubRepos`.
3. `usableEntry` classifies. `report` is total and takes the defect. `readEntries` applies with or
   without a defect: `workflowTasks` normalizes too.
4. Structured array: validate container and nested shapes, reject the whole invalid list on
   `set`/`setIfUnchanged` (add it to `describeInvalidStoredWrite`; nothing forces that), count sparse holes as invalid (JSON makes them `null`).
5. A report gating a destructive control: decide it in `StoredValueProblem` in core, like
   `nothingUsable`, so a new kind fails closed.
6. Widening `StoredValueProblem` with a required member fails `npm run lint` in
   `src/test/store-problem.ts` (the builder both renderer test files use), at `UNLOADABLE_FILE` in
   `src/components/Sidebar.test.tsx` (`wholeFile`, no `defect`) and in `core/store.test.ts`'s
   `describeHealedStoredValue` cases. Build new renderer fixtures with the helper.
7. Same-key policy: stated value, `set`; derived value, `setIfUnchanged` keyed on its `inspect()`,
   with `'superseded'` re-planning or refusing.
8. Renderer: IPC channels per [ipc-and-renderer-testing.md](ipc-and-renderer-testing.md). CLI:
   extend `cli/index.ts`, keeping `config show` redaction.

## When adding a backend

- Hand a `StoredValueBackend` to `createGuardedStore(backend, source)`. Never re-implement the
  composition: it is why the shells cannot answer differently. `core/store.test.ts` reads
  `electron/store.ts` and fails if the instance is used outside it.
- `set` writes one key into the file as it is now, never a snapshot of the others.
- Over a file, take the lock with `withFileWriteLock`; `openGuardedStoreFile` applies it itself.
- Supply a `getFresh` applying the root-shape rule (`loadStoredFileStrict`); `openGuardedStoreFile`
  does so.
- No backend read error reaches a caller; convert, never swallow: `asUnreadableStoreError` in
  `get()`, one `try` around probe and rules in `problems()`, `withoutStoredBytes` on writes. The
  last rewraps only `SyntaxError`: calling a failed write a failed read misdirects the operator.

## `inspect()` and `setIfUnchanged()` versus `get()`

- conf re-reads on every `get`. `FileStore.get()` answers from its constructor snapshot, so it
  supplies `getFresh`. Its constructor keeps the swallowing `load()` so read-only commands still
  answer.
- `loadStoredFileStrict()` throws for an existing unusable file, top-level
  `null`/array/string/number included: unreadable means "unknown", never "unchanged". Only `ENOENT`
  is benign.
- Take "is it usable?" and "what do I do?" from one `inspect()`, never `get()` + `problems()`.
  `createMaoApp` feeds the latch and `restore()` from one observation: with two, a value turning
  non-array in between reads healthy and the first tick overwrites it.
- `readable: false` is a third state, not a flavour of unusable: a caller about to write refuses.
- `setIfUnchanged()` wrote only on `'written'`; `'superseded'`, `'unverifiable'`, `'invalid'`,
  `StoreLockError` and a `storeWriteRequiresRestart()` refusal (`FileStore.writeKey`'s failed merge
  read) wrote nothing; any other throw is unknown. On that refusal a queue writer latches
  restart-required rather than recording an unknown write.
- Observing before an unconditional write destroys a repair landing in between and reports success.
  Key the write on the observation.
- The lock closes compare-to-write against MAO processes only, not a lockless writer (hand-edit,
  another tool, electron-store's constructor merge) or a lock broken while its holder lived. Never
  call it atomic in comments, operator text or member names (`writeStoreFileAtomic` names the
  rename). JSDoc: `MaoStore.setIfUnchanged`.

## Multi-process writes (issue #73)

- `FileStore.writeKey` merges one key into a strict fresh read; a failed read refuses,
  restart-required, never merging into `{}`.
- `writeStoreFileAtomic()` (see JSDoc) overwrites in place on `EBUSY`/`EXDEV`: refusing failed every
  write in a bind mount and tripped the marker.
- `createStoreWriteLock()` (see JSDoc): `STORE_LOCK_TIMEOUT_MS` 5 s, then `StoreLockError`; broken
  with a dead owner or past `STORE_LOCK_STALE_MS` 30 s. Not re-entrant.
- Derived values never use plain `set`: a change after the read is lost silently. Table:
  several-processes runbook.
- The base is what the caller derived from, for the GUI the renderer's view:
  `github:setRepos(next, base)`, `ai:save(providers, base)`. A save-time observation alone lets a
  stale window delete a terminal's change. See the JSDoc on `applyRepoListEdit`, and
  `src/components/GlobalSettings.tsx`.
- A refusal before the backend write is a `'not-written'` `QueuePersistenceError`, and the mutator
  rolls back (`notifyPublicMutation`), `appendTask()` included: auto-trigger labels nothing after a
  failed enqueue, so a kept task would persist beside its re-enqueue.

## Queue latch versus persistence marker

Two separate facts in separate fields. Never reuse the marker for the latch: `mao config show` would
claim a write failure.

| | Queue recovery latch | Persistence-broken marker |
| --- | --- | --- |
| Means | this process cannot use the stored queue | a queue write has an unknown or twice-refused outcome |
| `mao config show` | `workflowQueueRecoveryRequired`, `workflowQueueRestartRequired` | `workflowPersistenceBroken` |
| Durable state | none: derived from `store.inspect(QUEUE_GATING_FIELD)` at boot | `workflow-persistence-broken.marker` in the data dir, presence-only, outside `MaoStore` since a store flag retries the failed write |
| Set by | `requireQueueRecovery()`, before the `'change'` subscription and `restore()` | second `notifyAfterStage()` failure, `'unknown'` write, `'write-failed'`; rehydrated before restore |
| Cleared by | a write to that field, or restart after repair | reconciliation, marker clear, restart |

- Why latch: `startAutoTrigger()` ticks at once after `createMaoApp()`, and that enqueue's write
  would destroy the only salvageable copy and start a pipeline blind.
- It refuses `enqueue`, `enqueueFromIssue`, `retry`, `advance`, `setAutoAdvance`, `clearCompleted`
  before mutation and `notify()`, plus `processQueue`. `clearCompleted` emits `'change'`, so leaving
  it open replaces the value unconfirmed.
- The marker gates every public mutator and auto-trigger: a failed enqueue stays in memory
  unlabelled, so the next poll appends it again. `resume: false` is not enough: a later enqueue
  wakes restored pending tasks.

## Fresh observations: recovery and imminent public writes only

- `processQueue`, `safeToResume` and the `'change'` backstop read the latch field only; recovery
  observes in `healStoredQueue()`.
- `assertQueueWritable()` runs one whole-file probe just before each public mutation and, in
  `runStage()`, after long awaits and before each external write. It probes even past a field-only
  latch, so a later outage upgrades it. Auto-trigger makes only this observation while latched.
- Composite helpers check inside: `GithubService.createBranch()`/`commitFile()` (`beforeWrite`, just
  before the REST write), `commitAndPush()` (`beforePush`, just before `git push`). After they
  return is too late.
- Never probe in `notify()`: recovery writes do not emit, and a throwing listener reads as a
  persistence failure.
- `persistQueue()`'s compare is a write precondition, not a gate; one that cannot read latches
  restart-required.
- While halted the listener throws `QueuePersistenceError`: a silent return leaves durable `running`
  for restart to replay. Mutators roll back only a refusal known to precede the backend write; an
  `'unknown'` `QueuePersistenceError` records `persistenceBroken`; an unrelated observer's throw does
  neither.
- A whole-file failure latches at its first fresh observation, monotonically, before any GitHub
  call, mutation or recovery write. `STORE_RESTART_REQUIRED` replaces a field reason and survives a
  repair leaving only a field problem; `clearQueueRecovery()` refuses it. `FileStore` now merges
  fresh reads, so this is conservative policy; loosening it is its own change.
- A long-lived fresh reader owes a guard: `tick()` runs bare from `setInterval`, so a throw is an
  unhandled rejection. Its fixed diagnostic never interpolates the error.
- `pollNow()` owns the order: fresh read and latch, membership, preflight. Shells never read the
  list or preflight first.

## `workflowTasks` writers and `healStoredQueue()`

- Two writers, both conditional, both in `core/app.ts`: `persistQueue()` and `healStoredQueue()`.
  Recovery cannot use the listener (`emit()` cannot report a refusal) or the engine (it holds no
  store). Nothing else writes it. No test pins this:
  `git grep -nE "^[^*/]*\.set(IfUnchanged)?\((QUEUE_GATING_FIELD|'workflowTasks')" -- core cli electron ':!*.test.*'`
  must list only `core/app.ts`.
- Both call `recordQueueWrite()` to set `persistedQueueWitness`, or the next change refuses its own
  recovery.
- A moved usable queue is refused: task to `'error'`, one retry, then `persistenceBroken` and the
  marker.
- Exception: a queue gone unusable after a clean boot is repaired from the session's queue, only
  while `onlyHoldsTasksThisProcessWrote` holds over `ownTaskForms` (see JSDoc). A foreign readable
  task is a conflict, and `resaveStoredQueue()` refuses it. An entry this build cannot read counts
  as corruption and is discarded.
- `confirmQueueRecovery()` and `resaveStoredQueue()` share `healStoredQueue()` so neither drifts to
  an unconditional write. `'fresh-subset'` writes the fresh valid subset and restores with
  `resume: false`; the boot-time queue would delete a task another process added. `'live-engine'`
  writes the live queue.
- Keep `resaveStoredQueue()`'s refusal while halted: saving a filtered subset is silent deletion.
  The latch clears only after the write is confirmed, never through an emit. Step order: JSDoc on
  `healStoredQueue`.

## `QueueRecoveryOutcome`

Seven kinds, typed so CLI and GUI cannot disagree, with no backend error text. Only `'replaced'`
wrote; `'write-failed'` is unknown; the rest wrote nothing. Proof: `core/app.test.ts`.

| `kind` | Established | CLI says | Exit |
| --- | --- | --- | --- |
| `'replaced'` | Still unusable at the compare. Readable subset kept, invalid entries deleted; a `running` task restores as `pending`. Nothing resumes: use `mao run`; in a live host, later queue activity may run retained tasks | `Recovered the stored workflow queue: …` | 0 |
| `'already-readable'` | Something else repaired it; this process holds only a filtered subset. Restart | `The stored workflow queue reads normally — nothing was written. …` | 0 |
| `'restart-required'` | Whole-file failure observed, or compare `'unverifiable'`. Halt stays even if readable now. Repair, restart | `Nothing was written. This process observed …` | 1 |
| `'superseded'` | Value moved before the compare; something else writes the file. Re-check, retry | `The stored queue changed while confirming, …` | 1 |
| `'unverified'` | No safe replacement: marker set, lock held, re-save while halted, foreign tasks | `Nothing was written. <reason>` | 1 |
| `'invalid-replacement'` | Rejected before compare or backend write. Halt remains | `MAO rejected the readable task subset before writing …` | 1 |
| `'write-failed'` | Attempt threw. `markPersistenceBroken()` blocks queue work. Reconcile, clear the marker, restart | `The replacement write failed, …` | 1 |

## Whole-file refusal (issue #67)

- A write while the load failed replaces the blob with defaults, destroying the only `githubToken`.
  `assertStoredFileLoadable()` in `createGuardedStore.set()` refuses under the lock, for both
  backends and for corruption after boot, because the fresh read is strict for both.
- Refuse the write, never the boot: a throwing constructor takes `mao config show` and the Sidebar
  poll down too.
- MAO never renames or copies the file itself: an automatic rename plants the token at a second
  path the operator never chose. Moving it aside is the operator's call: `storeReadRemedy` offers it
  for bad JSON or a non-object root.
- `problems()` probes the file before the per-field rules, which otherwise read defaults and answer
  `[]`. One entry, on `QUEUE_GATING_FIELD` so `findStoredQueueProblem()` finds it; never
  `githubRepos`: the message is not about repositories. Its `nothingUsable: false` is what withholds
  the reset.
- `src/components/Sidebar.tsx` branches on `wholeFile`, never report text: a field problem heals on
  the next queue write, a file that did not load refuses every write.
- Never interpolate a read error, and never give `UnreadableStoreError` a `cause`: V8 puts the
  input's first ten characters in `SyntaxError.message`, and a file clobbered to a bare token is
  that input.

## Electron: conf is judged before it is constructed

Why: JSDoc on `openGuardedStoreFile`. Proof: `core/store.test.ts`.

- conf's constructor writes merged defaults back over a `null`, array, string or number root, before
  any `set()` exists. So `openGuardedStoreFile()` runs `loadStoredFileStrict()` first, and rewraps
  conf's parse error, which quotes the file.
- `electron/store.ts` pins `cwd` and `name`: the gate needs the path before an instance exists. The
  instance is never named, exported or read elsewhere.
- Never pass `clearInvalidConfig: true`: conf would write defaults over an unparseable file, past
  every gate.
- conf coerces a root replaced after boot, so `getFresh` comes from
  `loadStoredFileStrict(filePath)`, never conf.
- `deserialize: createStoredFileParser(configPath)` applies the rule to bytes conf itself parses,
  since a pre-check cannot cover a backend that reads again.
- Open, issue #91: construction throws at module load, so the app exits before a window, with no
  dialog. The bytes survive. Never call `mao config show` the recovery path unchecked: `build.files`
  in `package.json` ships no `dist-cli`, and the CLI's directory can differ from `userData`.

## When changing the Sidebar's store cards

An action's result must outlive the condition it reports on: `queueError` and `resetNotice` render
outside the card, because `already-readable` empties the problems and unmounts it. Proof:
`src/App.test.tsx`, `src/components/Sidebar.test.tsx`.

- Offer **Recover readable tasks** only while halted, field-only, with the store still unusable;
  recovery would overwrite a repair. Offer **Save this session's queue now** only when not halted
  with a field-level problem. Restart-only, `wholeFile` and marker states offer no queue write.
- Filter the queue's report from the generic list only when the queue card renders it.
- **Reset stored list**: only for a `githubRepos` problem with `nothingUsable`, never via `defect`
  in the renderer. Never another field: it deletes `githubRepos` only. Never a mixed list: the rows
  are real and Remove works.
- It writes an empty list on purpose: every row would be preflighted as new, and a revoked token
  would block the last recovery. With no rows there is no Settings tab and no Remove.
- `resetRepoList()` re-reads `app:storeProblems`, aborts on a failed read, and returns
  `RepoListResetOutcome` (`'replaced' | 'already-readable' | 'partly-usable'`), since
  `Promise<void>` cannot say nothing was written.
- Poll every `STORE_PROBLEM_POLL_MS` (30 s): a hand-edit must surface before the list write that
  destroys it. Never gate Add on a fresh read: `mao repos add` still performs that recovery.
- Re-read the list when the `githubRepos` report *text* changes, not every poll (mid-typing stomps).
  "Does a report exist" misses all-invalid to partly usable. `nothingUsable` misses `'some-entries'`
  to healthy: the warning vanishes and the rescued repository shows no row until the next list edit
  re-reads. `applyRepoListEdit` keeps it in the store, so the cost is a stale mirror, not deletion.
- `repoListWatch` in `src/App.tsx` (see JSDoc): `rereadOwed` clears only with the list in hand;
  never adopt `[]` on failure. `generation` drops a read overtaken by a report change or write.
  `writesInFlight` blocks starting one during a write. `adoption` lets only the newest read apply.
  `persistRepos`' `finally` must release the hold, or adoption stops for good.

## Operator runbook: several MAO processes on one config file

Supported: `mao run` or the desktop app beside one-shot commands. A write replaces only its key
under `config.json.lock`, so a `repos remove`, `set-token`, `import-providers` or theme change
survives the host's next queue write. The CLI keeps the file's mode and owner and writes through a
symlink. A bind-mounted file (`docker run -v ./config.json:/data/config.json`) is rewritten in
place, so a lockless reader can catch it half-done. The desktop app does not keep a `chmod 600`.

| Value | When two processes change it |
| --- | --- |
| `githubToken`, `theme`, `buildSha`, `import-providers` | plain `set`: last write wins |
| repositories, `repos add`/`remove` | written if unchanged; re-planned and re-preflighted up to `MAX_REPO_LIST_ATTEMPTS` (3), then `Nothing was written: …` |
| repositories, desktop app | only the window's edit applies to the list stored now; a settings edit to a repository removed elsewhere is dropped |
| providers, Global settings | written if still the list loaded or last saved, else `reopen Global settings and apply the edit again` |
| workflow queue | written if still the queue this process last read or wrote, else refused |

Run one queue host per config file: `mao run`, the desktop app, or a one-shot
`mao workflow enqueue`/`retry`/`advance`. Two engines can repeat GitHub work, so a moved queue sends
the stage to `error` with `another MAO process changed the stored workflow queue…`; the engine stops
and records `workflowPersistenceBroken`.

1. Stop the other hosts.
2. Check `mao workflow list` and the target repos for repeated work.
3. `mao config clear-persistence-broken` (desktop app: **Clear marker after verification**), then restart.

- A refused enqueue keeps nothing; a current host later enqueues the issue once.
- An idle host is refused but trips nothing. `mao run` logs the conflict on each poll that tries to
  enqueue, until restarted.
- Lock held: waits five seconds, then
  `Another MAO process is writing <file> (lock held by pid <pid> on <host>) … nothing was written. …`.
  A dead process's lock breaks automatically; another host's after 30 s. Delete `config.json.lock`
  by hand only if no MAO process is running.
- `mao run` polls a fresh repository list each tick. A `set-token` or `import-providers` takes
  effect on restart.

## Operator runbook: unusable stored list or list entry

The guard reports on stderr. Because `2>/dev/null` discards that, `mao config show` lists
`storeProblems` and stays parseable; the sidebar shows them in place of "No projects yet".

```
[store] "githubRepos" in <config> is an object, not a JSON array of { owner, repo } entries — ignoring it, …
[store] "githubRepos" in <config> is a JSON array in which 2 entries of 3 do not name a repository …
… drops them for good, so copy out anything you need first. …
```

`mao repos list`: a wrong container prints `[]`; an array prints as stored, junk included, so copy
from there.

| State | Healing write |
| --- | --- |
| Nothing usable | `mao repos remove <owner> <repo>`: registers nothing, never preflighted, always works. `mao repos add <owner> <repo>` or GUI Add: every entry is new, so it needs a working token, else fails leaving the value. GUI **Reset stored list** (two-step): empty list |
| Some usable | none offered. The next add, remove or settings edit drops the invalid entries for good: copy first |

- `mao repos add`/`remove` print `describeHealedStoredValue()`:
  `Replaced the unusable "githubRepos" value in <config>.` (wrong container),
  `Dropped the unusable "githubRepos" entries from <config>.` (array, no usable entry), or
  `Dropped the unusable "githubRepos" entries from <config>, keeping the readable ones.` (mixed)
- `aiProviders`: repair the file or `mao config import-providers <file>`; no GitHub token needed. No
  valid entry fails each stage with `No AI providers registered`.

## Operator runbook: recovering `workflowTasks`

A wrong container or one invalid entry halts:

```
$ mao run
[store] "workflowTasks" in <config> is an object, not a JSON array of queued workflow tasks — ignoring it, …
Nothing was started. Run `mao workflow confirm-queue-recovery` once you have salvaged anything you need.
$ echo $?
1
```

While halted: `mao run` exits 1 for cron without polling or resuming; auto-trigger spends no GitHub
call; `workflow enqueue`, `enqueue-existing`, `retry`, `advance`, `clear-completed` and their GUI
buttons refuse; **Refresh** rejects. Never run `mao config clear-persistence-broken` for this.

1. Copy what you need out of the invalid entries: recovery discards them for good.
2. Check the target repo for a `workflow-active` issue with a half-finished branch or PR and finish
   it by hand; a blind re-enqueue can open a second one.
3. `mao workflow confirm-queue-recovery`, or the sidebar's two-step **Recover readable tasks**: the
   only ungated queue path. Read the result in the outcome table above.

A hand-edit during recovery is overwritten while it reports success, so do not edit then. A held
lock reports `Nothing was written.` with the holder; retry.

**If `workflowPersistenceBroken` is true**, the durable queue may predate GitHub work. Queue
mutation, polling and stages are blocked here and in later starts; `mao run` prints the reason plus
`Nothing was started.` and exits 1. A later start sees it only if the marker file landed, because a
failed marker write is swallowed: if the process that hit the failure shows it, confirm
`workflow-persistence-broken.marker` exists before restarting, or the restart resumes.

1. Compare the queue with the actual issues, branches and PRs. `mao workflow list` prints the queue
   after `restore()`, so a task whose exit write failed shows `pending` with `active` cleared although
   its GitHub work may have landed: judge each task by its stage and the repository, not its status.
   A packaged GUI ships no CLI; from a source checkout,
   `MAO_DATA_DIR=<userData> npm run cli -- workflow list` reads Electron's file. The board shows this
   process's memory; a restart with the marker in place stays blocked.
2. `mao config clear-persistence-broken` (its own data dir), or in the GUI **Clear marker after
   verification** then **Confirm marker clear** (`workflow:clearPersistenceBroken`, Electron's
   `userData`). Two routes because a packaged GUI need not ship the CLI and their directories can
   differ. The GUI refuses while a stage is active (`assertCanClearPersistenceBroken`).
3. Start a fresh process: neither route releases the current one.

Never write around the marker with recovery or **Save this session's queue**. A queue or whole-file
problem beside it is independent: repair that too.

## Operator runbook: wrong-shaped `workflowTasks` after a clean start

The latch is decided at boot, so the session is not halted: its next queue write rewrites the field,
unless the field holds readable tasks it never loaded or wrote. Restarting first refuses unattended
work until the value is replaced.

- Never run `mao workflow confirm-queue-recovery` here: from another process it writes the
  fresh readable subset, often empty, and the live queue is lost when the session restarts unwritten.
- GUI: **Save this session's queue now** (`MaoApp.resaveStoredQueue()`). It refuses while halted and
  on foreign tasks, and says so if something repaired the file first.
- No GUI: let `mao run` reach its next queue write, or stop it and then recover.

## Operator runbook: whole-file read failure after startup

JSON unparseable or non-object, or reads denied. Every write is refused; auto-trigger's fresh
`inspect('githubRepos')` latches before any GitHub call; an in-flight workflow stops at its next
persist. The halt stays even if the file reads again, so neither queue action works in that process.

1. Stop any headless process.
2. Repair the JSON or permissions.
3. Restart MAO. Do not wait for a queue write: the gate prevents one.
4. An in-flight workflow may have done GitHub work after its last durable state: inspect queue and
   repo before resuming. Clear `workflowPersistenceBroken` only after that.

## Operator runbook: a `config.json` MAO cannot read at all

Unparseable, not an object (`null`, `[]`, a bare string), or not openable. Reads answer, every write
refuses, nothing is renamed. Copy what you need before repairing by hand.

```
$ mao config show
{ "githubToken": "[unset]", ..., "storeProblems": [ { "field": "workflowTasks", "message": "[store] <config> could not be
  read at all, so no stored value was established ... It is not valid JSON. Repair the JSON by hand, ..." } ] }
$ mao config set-theme dark
[mao] [store] Refusing to write "theme" to <config>, because the file could not be read. … Nothing has been written ...
```

- Any write, `mao repos remove` included, exits 1. `"[unset]"` is the defaulted read: never answer
  it with `set-token`.
- A missing `config.json` is a fresh install: silent, writes work, created on first save.
- `mao config clear-persistence-broken` does not load the store, so it works regardless.
- GUI: see issue #91.

## What the halt does not cover

- The latch means "no unattended pipeline work on this host", never "the file is fine".
- An unparseable file latches the queue (`inspect()`, `getFresh()`, `loadStrict()`, then
  `readable: false`). Other fields: a `FileStore` booted on it reads defaults, one booted clean its
  snapshot; conf's `get()` throws `UnreadableStoreError`. The write refusal, not the latch, stops
  the data loss.
- `mao swarm` reads none of this: separate Python engine, separate credential.
