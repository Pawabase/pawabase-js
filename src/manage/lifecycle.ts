import { Service, seg, type Api, type Body } from "./base.js";

/** The project's environments (`development`, `production`, previews…). Most calls here are not scoped to the client's environment. */
export class Environments extends Service {
  list(): Promise<Api> {
    return this.project("GET", "/envs");
  }

  /** A new environment, optionally with another's definitions copied in. */
  create(name: string, options: { copyFrom?: string } = {}): Promise<Api> {
    return this.project("POST", "/envs", { body: { name, copy_from: options.copyFrom } });
  }

  getOne(name?: string): Promise<Api> {
    return this.project("GET", `/envs/${encodeURIComponent(name ?? this.environment)}`);
  }

  /** Change an environment's infrastructure, sign-in settings or settings; each is merged in. */
  update(name: string, changes: { infra?: Body; auth?: Body; settings?: Body; isDefault?: boolean }): Promise<Api> {
    return this.project("PATCH", `/envs/${encodeURIComponent(name)}`, {
      body: { infra: changes.infra, auth: changes.auth, settings: changes.settings, is_default: changes.isDefault },
    });
  }

  deleteEnvironment(name: string): Promise<Api> {
    return this.project("DELETE", `/envs/${encodeURIComponent(name)}`);
  }

  /** A short-lived copy for a branch or pull request (`ref`: lowercase letters, digits and hyphens); it expires by itself. */
  createPreview(ref: string, options: { name?: string; expiresInHours?: number; infra?: Body; auth?: Body; settings?: Body } = {}): Promise<Api> {
    return this.post("/previews", {
      ref,
      name: options.name,
      expires_in_hours: options.expiresInHours ?? 72,
      infra: options.infra ?? {},
      auth: options.auth ?? {},
      settings: options.settings,
    });
  }

  deletePreview(preview: string): Promise<Api> {
    return this.del(seg("previews", preview));
  }

  /** Copy this environment's definitions (never secrets or keys) to `to`. `include` limits the kinds; `dryRun` only reports what would change. */
  promote(to: string, options: { include?: string[]; dryRun?: boolean } = {}): Promise<Api> {
    return this.post("/promote", { to, include: options.include, dry_run: options.dryRun ?? false });
  }

  /** Export definitions, roles and settings as a document another project can apply. */
  blueprint(): Promise<Api> {
    return this.get("/blueprint");
  }

  /** Build new environments from a blueprint; each must not exist yet. */
  applyBlueprint(blueprint: Body, environments: string[] = ["development", "production"]): Promise<Api> {
    return this.project("POST", "/blueprints/apply", { body: { blueprint, environments } });
  }

  /** Re-read the deployed function code now. */
  reloadCode(): Promise<Api> {
    return this.project("POST", "/code/reload");
  }
}

/**
 * API versions served side by side. `v1` is always the live API; releasing another environment's definitions as `v2` serves them at
 * `/rest/v2` over this environment's tables, until you retire it.
 */
export class Versions extends Service {
  /** The live API first, then every released version. */
  list(): Promise<Api> {
    return this.get("/versions");
  }

  /** Whether `fromEnv`'s definitions can be served here as a version, and what would be added or left out. */
  check(fromEnv: string): Promise<Api> {
    return this.post("/versions/check", { from_env: fromEnv });
  }

  /** Serve `fromEnv`'s definitions as `/rest/<name>` (`v2`, `v3`…). A name is never reused. */
  release(name: string, fromEnv: string, options: { notes?: string } = {}): Promise<Api> {
    return this.post("/versions", { name, from_env: fromEnv, notes: options.notes ?? "" });
  }

  /** Stop serving a version. */
  retire(name: string): Promise<Api> {
    return this.post(seg("versions", name, "retire"));
  }
}

export interface RestoreOptions {
  /** Parts to restore: `definitions`, `settings`, `users`, `data`. Default: every part the file holds. */
  include?: string[];
  /** `merge` adds and updates; `replace` first removes what the chosen parts hold and needs `confirm`. */
  strategy?: "merge" | "replace";
  dryRun?: boolean;
  /** For `replace`: the environment's name, typed out. */
  confirm?: string;
}

/** Whole-environment backups you download, stored snapshots, and restores. */
export class Backups extends Service {
  /** A backup document: `definitions`, `settings`, `users` and, with `data`, rows (up to `maxRows` per table). */
  download(options: { include?: string[]; data?: boolean; maxRows?: number } = {}): Promise<Api> {
    return this.get("/backup", { include: options.include?.join(","), data: options.data ? "true" : undefined, max_rows: options.maxRows });
  }

  /** Put a downloaded backup back. */
  restore(backup: Body, options: RestoreOptions = {}): Promise<Api> {
    return this.post("/restore", { backup, include: options.include, strategy: options.strategy ?? "merge", dry_run: options.dryRun ?? false, confirm: options.confirm });
  }

  /** Automatic snapshots: `frequency` hourly, daily (at `hour` UTC) or weekly (on `weekday`, 0 = Monday); older ones are pruned past `keepLast` and `keepDays`. */
  setSchedule(options: { enabled?: boolean; frequency?: "hourly" | "daily" | "weekly"; hour?: number; weekday?: number; keepLast?: number; keepDays?: number; include?: string[] } = {}): Promise<Api> {
    return this.put("/backup-schedule", {
      enabled: options.enabled ?? true,
      frequency: options.frequency ?? "daily",
      hour: options.hour ?? 3,
      weekday: options.weekday ?? 0,
      keep_last: options.keepLast ?? 7,
      keep_days: options.keepDays ?? 30,
      include: options.include ?? [],
    });
  }

  snapshots(): Promise<Api> {
    return this.get("/snapshots");
  }

  /** Take a snapshot now and keep it. */
  snapshot(name = "", options: { note?: string; include?: string[] } = {}): Promise<Api> {
    return this.post("/snapshots", { name, note: options.note ?? "", include: options.include });
  }

  /** Rename it, annotate it, or pin it so pruning keeps it. */
  updateSnapshot(snapshotId: string, changes: { name?: string; note?: string; pinned?: boolean }): Promise<Api> {
    return this.patch(seg("snapshots", snapshotId), changes);
  }

  removeSnapshot(snapshotId: string): Promise<Api> {
    return this.del(seg("snapshots", snapshotId));
  }

  downloadSnapshot(snapshotId: string): Promise<Api> {
    return this.get(seg("snapshots", snapshotId, "download"));
  }

  /** Check the stored snapshot is intact. */
  verifySnapshot(snapshotId: string): Promise<Api> {
    return this.post(seg("snapshots", snapshotId, "verify"));
  }

  /** Restore a snapshot; a snapshot of the current state is taken first unless `safetySnapshot` is `false`. */
  restoreSnapshot(snapshotId: string, options: RestoreOptions & { safetySnapshot?: boolean } = {}): Promise<Api> {
    return this.post(seg("snapshots", snapshotId, "restore"), {
      include: options.include,
      strategy: options.strategy ?? "merge",
      dry_run: options.dryRun ?? false,
      confirm: options.confirm,
      safety_snapshot: options.safetySnapshot ?? true,
    });
  }
}
