import { Service, seg, type Api, type Body } from "./base.js";

/** Deployed functions (Python or TypeScript; a project's functions are one language). */
export class Functions extends Service {
  /** Functions visible to the environment (and `branch`), each saying whether it came from a branch, a deployment or mounted code. */
  list(options: { branch?: string } = {}): Promise<Api> {
    return this.get("/functions", options);
  }

  /** Run a function now as an operator (or `asUser`), bypassing its HTTP policy: `{ status, result | error }`. */
  run(name: string, input?: unknown, options: { branch?: string; asUser?: Body } = {}): Promise<Api> {
    return this.post(seg("functions", name, "invoke"), { input, branch: options.branch ?? null, as_user: options.asUser ?? null });
  }

  /** Upload a base64 `.tar.gz` bundle (`functions/*.py` or `functions/*.ts`) and activate it. The `pawabase deploy` command builds the bundle. */
  deploy(archive: string, options: { branch?: string; manifest?: Body; runtime?: string; limits?: Body } = {}): Promise<Api> {
    return this.post("/function-deployments", {
      archive,
      branch: options.branch ?? "main",
      manifest: options.manifest ?? {},
      runtime: options.runtime ?? "python3.11",
      limits: options.limits ?? {},
    });
  }

  deployments(options: { branch?: string; limit?: number } = {}): Promise<Api> {
    return this.get("/function-deployments", { limit: 50, ...options });
  }

  deployment(deploymentId: string): Promise<Api> {
    return this.get(seg("function-deployments", deploymentId));
  }

  /** Make an earlier deployment the active one again (a rollback). */
  activate(deploymentId: string): Promise<Api> {
    return this.post(seg("function-deployments", deploymentId, "activate"));
  }

  removeDeployment(deploymentId: string): Promise<Api> {
    return this.del(seg("function-deployments", deploymentId));
  }

  branches(): Promise<Api> {
    return this.get("/function-branches");
  }

  /** Delete the functions deployed on `branch`. The environment's own are untouched. */
  removeBranch(branch: string): Promise<Api> {
    return this.del(seg("function-branches", branch));
  }

  runs(options: { function?: string; branch?: string; status?: string; after?: string; limit?: number } = {}): Promise<Api> {
    return this.get("/function-runs", { limit: 50, ...options });
  }

  /** One run with its input, output, error and logs. */
  runDetail(runId: string): Promise<Api> {
    return this.get(seg("function-runs", runId));
  }

  /** The files of the live deployment. */
  source(options: { branch?: string } = {}): Promise<Api> {
    return this.get("/function-source", options);
  }

  sourceFile(path: string, options: { branch?: string } = {}): Promise<Api> {
    return this.get("/function-source/file", { path, ...options });
  }
}
