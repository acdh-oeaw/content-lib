---
"@acdh-oeaw/content-lib": minor
---

regenerate incrementally and publish generated output atomically

- only re-read and re-transform items whose source file changed, instead of the whole corpus. a
  transform which reads other items through `context.collections` or `context.collection.data` is
  detected, and its collection keeps being transformed in full
- never delete the generated output root, and skip writing files whose content did not change, so
  unchanged modules keep their modification time and do not invalidate bundler caches
- write content-hashed modules before the collection index which references them, and remove
  obsolete modules only once the new index no longer points at them
- publish newly created items, which could previously be dropped: creating a file emits both a
  "create" and an "update" event, and only the "update" event survived debouncing
- apply filesystem events to the collection they came from, instead of to whichever collection
  happened to schedule the debounce timer
- serialize regenerations. a superseded regeneration could discard queued work belonging to the one
  replacing it, leaving the watcher permanently unable to publish
- keep watching when a `read()` or `transform()` throws, and when applying a filesystem event
  throws, instead of failing with an unhandled rejection. a `stat()` failure other than "not found",
  such as `EACCES` or `ELOOP` on a watched path, previously terminated the process
- add `idle()`, which resolves once no regeneration is pending, and `close()`, which stops watching
  and waits for an in-flight regeneration, so shutting down cannot leave a partially written output
  tree behind
