import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ApiError, createClient } from "../src/index.js";
import { admin } from "../src/admin.js";
import { closeAll, serve } from "./helpers.js";

after(closeAll);

const found = {
  connection: "acme-okta",
  type: "oidc",
  organization: { slug: "acme", name: "Acme" },
  required: true,
  url: "https://api.example.com/auth/v1/authorize/prod/acme-okta",
};

test("findSSO asks which company login serves an address, and answers null when none does", async () => {
  const fake = await serve((request) =>
    request.json?.email === "ada@acme.com" ? { body: found } : { status: 404, body: { detail: "no enterprise sign-in for this address" } },
  );
  const db = createClient({ url: fake.url, apiKey: "pb_pk_x", environment: "prod", retry: false, auth: { persistSession: false } });
  assert.deepEqual(await db.auth.findSSO({ email: "ada@acme.com" }), found);
  assert.equal(fake.requests[0]!.path, "/auth/v1/sso/lookup");
  assert.deepEqual(fake.requests[0]!.json, { email: "ada@acme.com" });
  assert.equal(await db.auth.findSSO({ email: "eve@gmail.com" }), null);
  await db.auth.findSSO({ organization: "acme" });
  assert.deepEqual(fake.requests[2]!.json, { organization: "acme" });
  db.dispose();
});

test("a password sign-in refused for a required company login carries the connection", async () => {
  const fake = await serve(() => ({
    status: 403,
    body: { code: "sso_required", message: "Acme signs its people in with its company login", connection: "acme-okta", organization: "acme" },
  }));
  const db = createClient({ url: fake.url, apiKey: "pb_pk_x", environment: "prod", retry: false, auth: { persistSession: false } });
  const refused = await db.auth.signInWithPassword({ email: "ada@acme.com", password: "p" }).catch((error: unknown) => error);
  assert.ok(refused instanceof ApiError);
  assert.equal(refused.status, 403);
  db.dispose();
});

test("admin ssoConnections speaks the server's field names", async () => {
  const fake = await serve(() => ({ body: { name: "acme-okta" } }));
  const a = admin(createClient({ url: fake.url, apiKey: "pb_sk_x", environment: "prod", retry: false }));
  await a.ssoConnections.create({
    name: "acme-okta",
    type: "oidc",
    organization: "acme",
    settings: { issuer: "https://acme.okta.com", client_id: "c", client_secret: "secret://OKTA" },
    defaultRole: "viewer",
    roleMapping: { Admins: "admin" },
    groupsAttribute: "groups",
  });
  await a.ssoConnections.update("acme-okta", { enabled: true, required: true, trustEmail: false });
  await a.ssoConnections.test("acme-okta");
  await a.ssoConnections.remove("acme-okta");
  const [create, update, check, remove] = fake.requests;
  assert.equal(create!.path, "/platform/v1/envs/prod/auth/sso-connections");
  assert.deepEqual(create!.json, {
    name: "acme-okta",
    type: "oidc",
    organization: "acme",
    settings: { issuer: "https://acme.okta.com", client_id: "c", client_secret: "secret://OKTA" },
    default_role: "viewer",
    groups_attribute: "groups",
    role_mapping: { Admins: "admin" },
  });
  assert.equal(update!.method, "PATCH");
  assert.deepEqual(update!.json, { enabled: true, trust_email: false, required: true });
  assert.equal(check!.path, "/platform/v1/envs/prod/auth/sso-connections/acme-okta/test");
  assert.equal(remove!.method, "DELETE");
});
