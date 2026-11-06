import { Definitions, Service, seg, type Api, type Body } from "./base.js";

/** Templates (subject, HTML, text) for the mail flows and sign-in send. */
export class MailTemplates extends Definitions {
  protected override readonly kind = "mail-templates";

  /** Rename a template, keeping its versions. */
  rename(name: string, to: string): Promise<Api> {
    return this.post(seg(this.kind, name, "rename"), { to });
  }
}

export class Mail extends Service {
  /** The brand kit the template editor uses: brand styles, palettes, reusable blocks and folders. */
  kit(): Promise<Api> {
    return this.get("/mail/kit");
  }

  saveKit(kit: { brand?: Body; palettes?: Body[]; blocks?: Body[]; folders?: string[] }): Promise<Api> {
    return this.put("/mail/kit", { brand: kit.brand ?? {}, palettes: kit.palettes ?? [], blocks: kit.blocks ?? [], folders: kit.folders ?? [] });
  }

  /** The delivery settings in effect (the password is never returned) and whether mail is being delivered. */
  config(): Promise<Api> {
    return this.get("/mail/config");
  }

  /** Messages sent or suppressed. `status`: `sent`, `failed`, `suppressed`. */
  log(options: { status?: string; limit?: number } = {}): Promise<Api> {
    return this.get("/mail/log", options);
  }

  sendTest(to: string[]): Promise<Api> {
    return this.post("/mail/test", { to });
  }
}
