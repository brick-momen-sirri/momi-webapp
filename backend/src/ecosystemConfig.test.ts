import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../ecosystem.config.cjs");

test("PM2 ecosystem syntax keeps the web gateway in both supported topologies", () => {
  const previousSplit = process.env.MOMI_TOPOLOGY_SPLIT;
  const previousShared = process.env.MOMI_SHARED_STATE;
  try {
    delete process.env.MOMI_TOPOLOGY_SPLIT;
    delete process.env.MOMI_SHARED_STATE;
    const monolith = loadConfig();
    assert.deepEqual(
      monolith.apps.map((app) => app.name),
      ["momi-backend", "momi-web"],
    );

    process.env.MOMI_TOPOLOGY_SPLIT = "true";
    const split = loadConfig();
    assert.deepEqual(
      split.apps.map((app) => app.name),
      ["momi-dispatcher", "momi-api", "momi-web"],
    );
    const web = split.apps.find((app) => app.name === "momi-web");
    assert(web);
    assert.equal(web.script, "dist/frontendServer.js");
    assert.equal(web.instances, 1);
    assert.equal(web.exec_mode, "fork");
    assert.equal(web.env.FRONTEND_PORT, "8190");
    assert.equal(web.env.FRONTEND_API_TARGET, "http://127.0.0.1:3333");
  } finally {
    restoreEnvironment("MOMI_TOPOLOGY_SPLIT", previousSplit);
    restoreEnvironment("MOMI_SHARED_STATE", previousShared);
    delete require.cache[configPath];
  }
});

function loadConfig() {
  delete require.cache[configPath];
  return require(configPath) as {
    apps: Array<{
      name: string;
      script: string;
      instances: number;
      exec_mode: string;
      env: Record<string, string>;
    }>;
  };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
