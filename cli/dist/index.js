#!/usr/bin/env node

// src/index.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import process from "process";
import { randomUUID } from "crypto";
import {
  DriftGateClient,
  DriftGateError
} from "@driftgate/sdk";
import { compileWorkflowYaml } from "@driftgate/workflow-compiler";
var REQUIRED_V4_ERROR_CODES = /* @__PURE__ */ new Set([
  "AUTH_INVALID",
  "POLICY_DENIED",
  "RISK_EXCEEDED",
  "ROUTE_UNAVAILABLE",
  "TOOL_BLOCKED",
  "RATE_LIMITED",
  "TIMEOUT",
  "INTERNAL",
  "INVALID_REQUEST"
]);
async function main() {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "login":
      await handleLogin(rest);
      return;
    case "init":
      await handleInit(rest);
      return;
    case "deploy":
      await handleDeploy(rest);
      return;
    case "publish":
      await handlePublish(rest);
      return;
    case "session":
      await handleSession(rest);
      return;
    case "execute":
      await handleExecute(rest);
      return;
    case "execution":
      await handleExecution(rest);
      return;
    case "run":
      throw deprecatedCommandError("run", "driftgate session execute <sessionId> --input '{...}'");
    case "status":
      throw deprecatedCommandError("status", "driftgate execution status <executionId>");
    case "approvals":
      await handleApprovals(rest);
      return;
    case "connectors":
      await handleConnectors(rest);
      return;
    case "secrets":
      await handleSecrets(rest);
      return;
    case "webhooks":
      await handleWebhooks(rest);
      return;
    case "help":
    case "--help":
    case "-h":
    case void 0:
      printHelp();
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
function parseArgs(input) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = input[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { positionals, options };
}
function resolveBaseUrl(args, config) {
  const option = args.options["api-base"];
  if (typeof option === "string" && option.length > 0) {
    return option.replace(/\/$/, "");
  }
  const envBase = process.env.DG_API_BASE ?? process.env.DRIFTGATE_API_BASE;
  if (envBase && envBase.length > 0) {
    return envBase.replace(/\/$/, "");
  }
  if (config?.baseUrl) {
    return config.baseUrl.replace(/\/$/, "");
  }
  return "http://127.0.0.1:3001";
}
function getConfigDir() {
  const custom = process.env.DRIFTGATE_CLI_CONFIG_DIR;
  if (custom && custom.length > 0) {
    return custom;
  }
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is required for CLI config storage");
  }
  return path.join(home, ".config", "driftgate");
}
function getConfigPath() {
  return path.join(getConfigDir(), "credentials.json");
}
async function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}
async function saveConfig(config) {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2));
}
function buildClient(baseUrl, config) {
  const apiKey = process.env.DRIFTGATE_API_KEY ?? config?.apiKey;
  const sessionToken = apiKey ? void 0 : process.env.DRIFTGATE_SESSION_TOKEN ?? config?.sessionToken;
  if (!apiKey && !sessionToken) {
    throw new Error("no credentials found; run `driftgate login` or set DRIFTGATE_API_KEY");
  }
  return new DriftGateClient({
    baseUrl,
    apiKey,
    sessionToken
  });
}
function requireWorkspaceId(args, usage) {
  const workspaceId = typeof args.options.workspace === "string" && args.options.workspace || process.env.DRIFTGATE_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error(usage);
  }
  return workspaceId;
}
function parseBooleanValue(value, label) {
  if (value === void 0) {
    return void 0;
  }
  if (value === true) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be one of: true|false|1|0|yes|no|on|off`);
}
async function parseJsonObjectOption(value, label, fallback) {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}
function parseNullableConnectorId(value) {
  if (value === void 0 || value === true) {
    return void 0;
  }
  if (value.trim().toLowerCase() === "null") {
    return null;
  }
  return value;
}
function optionString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function deprecatedCommandError(command, replacement) {
  return new Error(`command '${command}' was removed in V4 CLI; use '${replacement}'`);
}
function nowNs() {
  return process.hrtime.bigint();
}
function elapsedMs(startNs) {
  const elapsed = process.hrtime.bigint() - startNs;
  return Number((Number(elapsed) / 1e6).toFixed(3));
}
function parseNumberOption(value, label, { integer = false, minimum } = {}) {
  const raw = optionString(value);
  if (!raw) {
    return void 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  if (minimum !== void 0 && parsed < minimum) {
    throw new Error(`${label} must be >= ${minimum}`);
  }
  return parsed;
}
async function parseRequiredInputOption(args) {
  const rawInput = optionString(args.options.input);
  if (!rawInput) {
    throw new Error("usage: --input '{...}' or --input @input.json is required");
  }
  const source = rawInput.startsWith("@") ? await readFile(rawInput.slice(1), "utf8") : rawInput;
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must parse to a JSON object");
  }
  return parsed;
}
async function parsePolicyOption(args) {
  const policyOption = optionString(args.options.policy);
  if (policyOption) {
    const value = await parseJsonObjectOption(policyOption, "--policy", {});
    const ref2 = typeof value.ref === "string" ? value.ref : void 0;
    const version2 = typeof value.version === "string" ? value.version : void 0;
    if (!ref2 || !version2) {
      throw new Error("--policy requires JSON object with string fields 'ref' and 'version'");
    }
    return { ref: ref2, version: version2 };
  }
  const ref = optionString(args.options["policy-ref"]);
  const version = optionString(args.options["policy-version"]);
  if (!ref && !version) {
    return void 0;
  }
  if (!ref || !version) {
    throw new Error("--policy-ref and --policy-version must be provided together");
  }
  return { ref, version };
}
async function parseRouteOption(args) {
  const routeOption = optionString(args.options.route);
  if (routeOption) {
    const value = await parseJsonObjectOption(routeOption, "--route", {});
    const provider2 = typeof value.provider === "string" ? value.provider : void 0;
    const model2 = typeof value.model === "string" ? value.model : void 0;
    const region2 = typeof value.region === "string" ? value.region : void 0;
    if (!provider2 && !model2 && !region2) {
      throw new Error("--route requires at least one of provider/model/region");
    }
    return { provider: provider2, model: model2, region: region2 };
  }
  const provider = optionString(args.options["route-provider"]);
  const model = optionString(args.options["route-model"]);
  const region = optionString(args.options["route-region"]);
  if (!provider && !model && !region) {
    return void 0;
  }
  return { provider, model, region };
}
async function parseRiskOption(args) {
  const riskOption = optionString(args.options.risk);
  if (riskOption) {
    const value = await parseJsonObjectOption(riskOption, "--risk", {});
    const score2 = typeof value.score === "number" ? value.score : void 0;
    const decision2 = value.decision === "allow" || value.decision === "deny" || value.decision === "review" ? value.decision : void 0;
    if (score2 === void 0 && decision2 === void 0) {
      throw new Error("--risk requires at least one of score/decision");
    }
    return { score: score2, decision: decision2 };
  }
  const score = parseNumberOption(args.options["risk-score"], "--risk-score");
  const decisionRaw = optionString(args.options["risk-decision"]);
  if (decisionRaw && !["allow", "deny", "review"].includes(decisionRaw)) {
    throw new Error("--risk-decision must be one of: allow|deny|review");
  }
  const decision = decisionRaw;
  if (score === void 0 && decision === void 0) {
    return void 0;
  }
  return { score, decision };
}
async function parseV4ExecutionDefaults(args) {
  return {
    policy: await parsePolicyOption(args),
    route: await parseRouteOption(args),
    risk: await parseRiskOption(args),
    workflowVersionId: optionString(args.options["workflow-version-id"])
  };
}
function canonicalOutput(response) {
  return {
    ok: response.ok,
    data: response.data,
    meta: response.meta,
    error: response.error
  };
}
function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
function mapStableErrorCode(inputCode, status) {
  const normalized = inputCode.trim().toUpperCase();
  if (REQUIRED_V4_ERROR_CODES.has(normalized)) {
    return normalized;
  }
  switch (normalized) {
    case "FORBIDDEN":
    case "POLICY_DENIED":
    case "ENTITLEMENT_DENIED":
      return "POLICY_DENIED";
    case "UNAUTHORIZED":
    case "AUTH_INVALID":
      return "AUTH_INVALID";
    case "FIREWALL_DENIED":
    case "TOOL_BLOCKED":
      return "TOOL_BLOCKED";
    case "NOT_FOUND":
      return "ROUTE_UNAVAILABLE";
    case "TIMEOUT":
      return "TIMEOUT";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "RISK_EXCEEDED":
      return "RISK_EXCEEDED";
    case "INVALID_REQUEST":
      return "INVALID_REQUEST";
    default:
      break;
  }
  if (status === 401 || status === 403) {
    return "AUTH_INVALID";
  }
  if (status === 404) {
    return "ROUTE_UNAVAILABLE";
  }
  if (status === 408 || status === 504) {
    return "TIMEOUT";
  }
  if (status === 429) {
    return "RATE_LIMITED";
  }
  return "INTERNAL";
}
function renderErrorEnvelope(error) {
  if (error instanceof DriftGateError) {
    const code2 = mapStableErrorCode(error.code, error.status);
    const retryable = code2 === "RATE_LIMITED" || code2 === "TIMEOUT" || error.status >= 500 || error.status === 429;
    return {
      ok: false,
      data: null,
      meta: {
        requestId: error.correlationId ?? `cli_${randomUUID()}`,
        timingMs: { total: 0 }
      },
      error: {
        code: code2,
        message: error.message,
        status: error.status,
        retryable,
        ...error.details && typeof error.details === "object" ? { details: error.details } : {}
      }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const isUsageError = message.startsWith("usage:") || message.includes("removed in V4 CLI");
  const status = isUsageError ? 400 : 500;
  const code = isUsageError ? "INVALID_REQUEST" : "INTERNAL";
  return {
    ok: false,
    data: null,
    meta: {
      requestId: `cli_${randomUUID()}`,
      timingMs: { total: 0 }
    },
    error: {
      code,
      message,
      status,
      retryable: false
    }
  };
}
async function handleLogin(rest) {
  const args = parseArgs(rest);
  const existingConfig = await loadConfig();
  const baseUrl = resolveBaseUrl(args, existingConfig ?? void 0);
  const directApiKey = process.env.DRIFTGATE_API_KEY;
  if (directApiKey && directApiKey.length > 0) {
    await saveConfig({ baseUrl, apiKey: directApiKey });
    console.log("Saved API key credentials for DriftGate CLI.");
    return;
  }
  const auth0Domain = process.env.AUTH0_DOMAIN;
  const auth0ClientId = process.env.AUTH0_CLIENT_ID;
  if (!auth0Domain || !auth0ClientId) {
    throw new Error("AUTH0_DOMAIN and AUTH0_CLIENT_ID are required for device-code login");
  }
  const auth0Audience = process.env.AUTH0_AUDIENCE;
  const deviceCodeResponse = await fetch(`https://${auth0Domain}/oauth/device/code`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: auth0ClientId,
      scope: "openid profile email offline_access",
      ...auth0Audience ? { audience: auth0Audience } : {}
    })
  });
  if (!deviceCodeResponse.ok) {
    const body = await deviceCodeResponse.text();
    throw new Error(`device-code start failed (${deviceCodeResponse.status}): ${body}`);
  }
  const deviceBody = await deviceCodeResponse.json();
  console.log("Complete DriftGate login in your browser:");
  console.log(deviceBody.verification_uri_complete ?? deviceBody.verification_uri);
  console.log(`User code: ${deviceBody.user_code}`);
  const tokenEndpoint = `https://${auth0Domain}/oauth/token`;
  const pollIntervalMs = (deviceBody.interval ?? 5) * 1e3;
  const timeoutAt = Date.now() + deviceBody.expires_in * 1e3;
  let idToken = null;
  while (Date.now() < timeoutAt) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceBody.device_code,
        client_id: auth0ClientId
      })
    });
    const tokenJson = await tokenResponse.json();
    if (tokenResponse.ok) {
      idToken = tokenJson.id_token ?? null;
      break;
    }
    if (tokenJson.error === "authorization_pending" || tokenJson.error === "slow_down") {
      continue;
    }
    throw new Error(
      `device-code login failed: ${tokenJson.error ?? "unknown_error"} ${tokenJson.error_description ?? ""}`
    );
  }
  if (!idToken) {
    throw new Error("device-code login timed out or missing id_token in token response");
  }
  const exchangeResponse = await fetch(`${baseUrl}/v1/auth/session/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ idToken })
  });
  const exchangeBody = await exchangeResponse.json();
  if (!exchangeResponse.ok || typeof exchangeBody.sessionToken !== "string") {
    throw new Error(`session exchange failed (${exchangeResponse.status}): ${JSON.stringify(exchangeBody)}`);
  }
  await saveConfig({
    baseUrl,
    sessionToken: exchangeBody.sessionToken,
    expiresAt: typeof exchangeBody.expiresAt === "string" ? exchangeBody.expiresAt : void 0
  });
  console.log("Device-code login successful. Session token stored for DriftGate CLI.");
}
async function handleInit(rest) {
  const args = parseArgs(rest);
  const outputPath = typeof args.options["out"] === "string" && args.options["out"] || "workflow.yaml";
  if (existsSync(outputPath) && args.options.force !== true) {
    throw new Error(`${outputPath} already exists. Pass --force to overwrite.`);
  }
  const template = `apiVersion: driftgate.ai/v1
kind: Workflow
metadata:
  name: starter-workflow
  workspace: workspace_id_here
spec:
  governance:
    policyBindings: []
    slaBindings: []
  nodes:
    - id: intake
      type: http
      config:
        method: POST
        path: /intake
    - id: complete
      type: task
      config: {}
  edges:
    - from: intake
      to: complete
`;
  await writeFile(outputPath, template, "utf8");
  console.log(`Created ${outputPath}`);
}
async function handleDeploy(rest) {
  const args = parseArgs(rest);
  const [yamlPath] = args.positionals;
  if (!yamlPath) {
    throw new Error("usage: driftgate deploy <workflow.yaml> [--workspace <workspaceId>] [--project <name>] [--workflow <name>]");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const workflowYaml = await readFile(yamlPath, "utf8");
  const compiled = compileWorkflowYaml(workflowYaml);
  const workspaceId = typeof args.options.workspace === "string" && args.options.workspace || process.env.DRIFTGATE_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error("workspace id is required (--workspace or DRIFTGATE_WORKSPACE_ID)");
  }
  const response = await client.deployWorkflow({
    workspaceId,
    projectName: typeof args.options.project === "string" && args.options.project || compiled.workflow.metadata.name,
    workflowName: typeof args.options.workflow === "string" && args.options.workflow || compiled.workflow.metadata.name,
    workflowYaml
  });
  console.log(
    JSON.stringify(
      {
        workflowId: response.workflow.id,
        projectId: response.project.id,
        draftVersion: response.draft.version,
        checksum: response.compile.checksum,
        mutationNodeIds: response.compile.mutationNodeIds
      },
      null,
      2
    )
  );
}
async function handlePublish(rest) {
  const args = parseArgs(rest);
  const [workflowId] = args.positionals;
  if (!workflowId) {
    throw new Error("usage: driftgate publish <workflowId> [--yaml <workflow.yaml>]");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const yamlPath = typeof args.options.yaml === "string" ? args.options.yaml : null;
  const workflowYaml = yamlPath ? await readFile(yamlPath, "utf8") : void 0;
  const version = await client.publishWorkflow(workflowId, workflowYaml);
  console.log(JSON.stringify(version, null, 2));
}
async function handleSession(rest) {
  const [subcommand, ...tail] = rest;
  switch (subcommand) {
    case "start":
      await handleSessionStart(tail);
      return;
    case "execute":
      await handleSessionExecute(tail);
      return;
    default:
      throw new Error(
        "usage: driftgate session start --agent <agent> [--workspace <workspaceId>] [--metadata '{...}'] [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>] [--expires-at <ISO-8601>] | driftgate session execute <sessionId> --input '{...}' [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>]"
      );
  }
}
async function handleSessionStart(rest) {
  const args = parseArgs(rest);
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const agent = optionString(args.options.agent);
  if (!agent) {
    throw new Error(
      "usage: driftgate session start --agent <agent> [--workspace <workspaceId>] [--metadata '{...}'] [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>] [--expires-at <ISO-8601>]"
    );
  }
  const metadata = typeof args.options.metadata === "string" ? await parseJsonObjectOption(args.options.metadata, "--metadata", {}) : void 0;
  const workspaceId = optionString(args.options.workspace) ?? process.env.DRIFTGATE_WORKSPACE_ID;
  const input = {
    ...workspaceId ? { workspaceId } : {},
    agent,
    ...optionString(args.options.subject) ? { subject: optionString(args.options.subject) } : {},
    ...metadata ? { metadata } : {},
    ...await parseV4ExecutionDefaults(args),
    ...optionString(args.options["expires-at"]) ? { expiresAt: optionString(args.options["expires-at"]) } : {}
  };
  const session = await client.session.start(input);
  printJson(canonicalOutput(session.startEnvelope));
}
async function handleSessionExecute(rest) {
  const args = parseArgs(rest);
  const [sessionId] = args.positionals;
  if (!sessionId) {
    throw new Error(
      "usage: driftgate session execute <sessionId> --input '{...}' [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>]"
    );
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const input = {
    input: await parseRequiredInputOption(args),
    ...await parseV4ExecutionDefaults(args)
  };
  const response = await client.executeSession(sessionId, input);
  printJson(canonicalOutput(response));
}
async function handleExecute(rest) {
  const args = parseArgs(rest);
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const agent = optionString(args.options.agent);
  if (!agent) {
    throw new Error(
      "usage: driftgate execute --agent <agent> --input '{...}' [--workspace <workspaceId>] [--metadata '{...}'] [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>]"
    );
  }
  const metadata = typeof args.options.metadata === "string" ? await parseJsonObjectOption(args.options.metadata, "--metadata", {}) : void 0;
  const workspaceId = optionString(args.options.workspace) ?? process.env.DRIFTGATE_WORKSPACE_ID;
  const input = {
    ...workspaceId ? { workspaceId } : {},
    agent,
    ...optionString(args.options.subject) ? { subject: optionString(args.options.subject) } : {},
    ...metadata ? { metadata } : {},
    ...await parseV4ExecutionDefaults(args),
    input: await parseRequiredInputOption(args)
  };
  const response = await client.execute(input);
  printJson(canonicalOutput(response));
}
async function handleExecution(rest) {
  const [subcommand, ...tail] = rest;
  switch (subcommand) {
    case "status":
      await handleExecutionStatus(tail);
      return;
    case "events":
      await handleExecutionEvents(tail);
      return;
    case "wait":
      await handleExecutionWait(tail);
      return;
    default:
      throw new Error(
        "usage: driftgate execution status <executionId> | driftgate execution events <executionId> | driftgate execution wait <executionId> [--interval-ms <ms>] [--timeout-ms <ms>]"
      );
  }
}
async function handleExecutionStatus(rest) {
  const args = parseArgs(rest);
  const [executionId] = args.positionals;
  if (!executionId) {
    throw new Error("usage: driftgate execution status <executionId>");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const startedAtNs = nowNs();
  const response = await client.status(executionId);
  const events = await client.events(executionId);
  const requestId = typeof response.run.correlationId === "string" && response.run.correlationId.length > 0 ? response.run.correlationId : `cli_${randomUUID()}`;
  printJson({
    ok: true,
    data: {
      run: response.run,
      approval: response.approval ?? null,
      latestEvent: events.length > 0 ? events[events.length - 1] : null,
      sourcePath: "/v1/headless/runs/:runId"
    },
    meta: {
      requestId,
      executionId,
      timingMs: { total: elapsedMs(startedAtNs) }
    },
    error: null
  });
}
async function handleExecutionEvents(rest) {
  const args = parseArgs(rest);
  const [executionId] = args.positionals;
  if (!executionId) {
    throw new Error("usage: driftgate execution events <executionId>");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const startedAtNs = nowNs();
  const events = await client.events(executionId);
  printJson({
    ok: true,
    data: {
      events,
      sourcePath: "/v1/headless/runs/:runId/events"
    },
    meta: {
      requestId: `cli_${randomUUID()}`,
      executionId,
      timingMs: { total: elapsedMs(startedAtNs) }
    },
    error: null
  });
}
async function handleExecutionWait(rest) {
  const args = parseArgs(rest);
  const [executionId] = args.positionals;
  if (!executionId) {
    throw new Error("usage: driftgate execution wait <executionId> [--interval-ms <ms>] [--timeout-ms <ms>]");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  const intervalMs = parseNumberOption(args.options["interval-ms"], "--interval-ms", {
    integer: true,
    minimum: 1
  });
  const timeoutMs = parseNumberOption(args.options["timeout-ms"], "--timeout-ms", {
    integer: true,
    minimum: 1
  });
  const startedAtNs = nowNs();
  const response = await client.waitForTerminal(executionId, {
    ...intervalMs !== void 0 ? { intervalMs } : {},
    ...timeoutMs !== void 0 ? { timeoutMs } : {}
  });
  const requestId = typeof response.run.correlationId === "string" && response.run.correlationId.length > 0 ? response.run.correlationId : `cli_${randomUUID()}`;
  printJson({
    ok: true,
    data: {
      run: response.run,
      approval: response.approval ?? null,
      sourcePath: "/v1/headless/runs/:runId"
    },
    meta: {
      requestId,
      executionId,
      timingMs: { total: elapsedMs(startedAtNs) }
    },
    error: null
  });
}
async function handleApprovals(rest) {
  const args = parseArgs(rest);
  const [subcommand, subject] = args.positionals;
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  if (subcommand === "list") {
    const workspaceId = typeof args.options.workspace === "string" && args.options.workspace || process.env.DRIFTGATE_WORKSPACE_ID;
    if (!workspaceId) {
      throw new Error("usage: driftgate approvals list --workspace <workspaceId>");
    }
    const status = typeof args.options.status === "string" ? args.options.status : void 0;
    const approvals = await client.approvals.list(workspaceId, status);
    console.log(JSON.stringify(approvals, null, 2));
    return;
  }
  if (subcommand === "approve") {
    if (!subject) {
      throw new Error("usage: driftgate approvals approve <approvalId>");
    }
    const result = await client.approvals.approve(subject);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "deny") {
    if (!subject) {
      throw new Error("usage: driftgate approvals deny <approvalId>");
    }
    const result = await client.approvals.deny(subject);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error("usage: driftgate approvals list|approve|deny ...");
}
async function handleConnectors(rest) {
  const args = parseArgs(rest);
  const [subcommand, connectorId] = args.positionals;
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  if (subcommand === "list") {
    const workspaceId = requireWorkspaceId(args, "usage: driftgate connectors list --workspace <workspaceId>");
    const connectors = await client.connectors.list(workspaceId);
    console.log(JSON.stringify(connectors, null, 2));
    return;
  }
  if (subcommand === "create") {
    const workspaceId = requireWorkspaceId(
      args,
      "usage: driftgate connectors create --workspace <workspaceId> --name <name> --type <connectorType> [--status active|disabled] [--config '{...}']"
    );
    const name = typeof args.options.name === "string" ? args.options.name : "";
    const connectorType = typeof args.options.type === "string" ? args.options.type : "";
    if (!name || !connectorType) {
      throw new Error("usage: driftgate connectors create --workspace <workspaceId> --name <name> --type <connectorType>");
    }
    const configJson = await parseJsonObjectOption(args.options.config, "--config", {});
    const status = typeof args.options.status === "string" ? args.options.status : void 0;
    const connector = await client.connectors.create(workspaceId, {
      name,
      connectorType,
      status,
      config: configJson
    });
    console.log(JSON.stringify(connector, null, 2));
    return;
  }
  if (subcommand === "update") {
    if (!connectorId) {
      throw new Error("usage: driftgate connectors update <connectorId> --workspace <workspaceId> [--name <name>] [--type <connectorType>] [--status active|disabled] [--config '{...}']");
    }
    const workspaceId = requireWorkspaceId(args, "usage: driftgate connectors update <connectorId> --workspace <workspaceId> ...");
    const configPatch = typeof args.options.config === "string" ? await parseJsonObjectOption(args.options.config, "--config", {}) : void 0;
    const input = {
      ...typeof args.options.name === "string" ? { name: args.options.name } : {},
      ...typeof args.options.type === "string" ? { connectorType: args.options.type } : {},
      ...typeof args.options.status === "string" ? { status: args.options.status } : {},
      ...configPatch ? { config: configPatch } : {}
    };
    if (Object.keys(input).length === 0) {
      throw new Error("usage: driftgate connectors update <connectorId> --workspace <workspaceId> requires at least one field");
    }
    const connector = await client.connectors.update(workspaceId, connectorId, input);
    console.log(JSON.stringify(connector, null, 2));
    return;
  }
  if (subcommand === "delete") {
    if (!connectorId) {
      throw new Error("usage: driftgate connectors delete <connectorId> --workspace <workspaceId>");
    }
    const workspaceId = requireWorkspaceId(args, "usage: driftgate connectors delete <connectorId> --workspace <workspaceId>");
    const connector = await client.connectors.delete(workspaceId, connectorId);
    console.log(JSON.stringify(connector, null, 2));
    return;
  }
  throw new Error("usage: driftgate connectors list|create|update|delete ...");
}
async function handleSecrets(rest) {
  const args = parseArgs(rest);
  const [subcommand, secretId] = args.positionals;
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  if (subcommand === "list") {
    const workspaceId = requireWorkspaceId(args, "usage: driftgate secrets list --workspace <workspaceId>");
    const secrets = await client.secrets.list(workspaceId);
    console.log(JSON.stringify(secrets, null, 2));
    return;
  }
  if (subcommand === "create") {
    const workspaceId = requireWorkspaceId(
      args,
      "usage: driftgate secrets create --workspace <workspaceId> --name <name> --value <value> [--connector-id <id|null>] [--metadata '{...}']"
    );
    const name = typeof args.options.name === "string" ? args.options.name : "";
    const value = typeof args.options.value === "string" ? args.options.value : "";
    if (!name || !value) {
      throw new Error("usage: driftgate secrets create --workspace <workspaceId> --name <name> --value <value>");
    }
    const metadata = await parseJsonObjectOption(args.options.metadata, "--metadata", {});
    const secret = await client.secrets.create(workspaceId, {
      name,
      value,
      connectorId: parseNullableConnectorId(args.options["connector-id"]),
      keyVersion: typeof args.options["key-version"] === "string" ? args.options["key-version"] : void 0,
      metadata
    });
    console.log(JSON.stringify(secret, null, 2));
    return;
  }
  if (subcommand === "update") {
    if (!secretId) {
      throw new Error("usage: driftgate secrets update <secretId> --workspace <workspaceId> [--name <name>] [--value <value>] [--connector-id <id|null>] [--metadata '{...}']");
    }
    const workspaceId = requireWorkspaceId(args, "usage: driftgate secrets update <secretId> --workspace <workspaceId> ...");
    const metadataPatch = typeof args.options.metadata === "string" ? await parseJsonObjectOption(args.options.metadata, "--metadata", {}) : void 0;
    const input = {
      ...typeof args.options.name === "string" ? { name: args.options.name } : {},
      ...typeof args.options.value === "string" ? { value: args.options.value } : {},
      ...args.options["connector-id"] !== void 0 ? { connectorId: parseNullableConnectorId(args.options["connector-id"]) } : {},
      ...typeof args.options["key-version"] === "string" ? { keyVersion: args.options["key-version"] } : {},
      ...metadataPatch ? { metadata: metadataPatch } : {}
    };
    if (Object.keys(input).length === 0) {
      throw new Error("usage: driftgate secrets update <secretId> --workspace <workspaceId> requires at least one field");
    }
    const secret = await client.secrets.update(workspaceId, secretId, input);
    console.log(JSON.stringify(secret, null, 2));
    return;
  }
  if (subcommand === "delete") {
    if (!secretId) {
      throw new Error("usage: driftgate secrets delete <secretId> --workspace <workspaceId>");
    }
    const workspaceId = requireWorkspaceId(args, "usage: driftgate secrets delete <secretId> --workspace <workspaceId>");
    const secret = await client.secrets.delete(workspaceId, secretId);
    console.log(JSON.stringify(secret, null, 2));
    return;
  }
  throw new Error("usage: driftgate secrets list|create|update|delete ...");
}
async function handleWebhooks(rest) {
  const args = parseArgs(rest);
  const [subcommand, webhookId] = args.positionals;
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? void 0);
  const client = buildClient(baseUrl, config);
  if (subcommand === "list") {
    const workspaceId = requireWorkspaceId(args, "usage: driftgate webhooks list --workspace <workspaceId>");
    const webhooks = await client.webhooks.list(workspaceId);
    console.log(JSON.stringify(webhooks, null, 2));
    return;
  }
  if (subcommand === "create") {
    const workspaceId = requireWorkspaceId(
      args,
      "usage: driftgate webhooks create --workspace <workspaceId> --name <name> --path </hook> --target-workflow <workflowId> --signing-secret <secret>"
    );
    const name = typeof args.options.name === "string" ? args.options.name : "";
    const hookPath = typeof args.options.path === "string" ? args.options.path : "";
    const targetWorkflowId = typeof args.options["target-workflow"] === "string" ? args.options["target-workflow"] : "";
    const signingSecret = typeof args.options["signing-secret"] === "string" ? args.options["signing-secret"] : "";
    if (!name || !hookPath || !targetWorkflowId || !signingSecret) {
      throw new Error(
        "usage: driftgate webhooks create --workspace <workspaceId> --name <name> --path </hook> --target-workflow <workflowId> --signing-secret <secret>"
      );
    }
    const eventFilter = await parseJsonObjectOption(args.options["event-filter"], "--event-filter", {});
    const executionJson = await parseJsonObjectOption(args.options.execution, "--execution", {});
    const requiresApproval = parseBooleanValue(args.options["requires-approval"], "--requires-approval");
    const execution = {
      ...executionJson,
      ...requiresApproval !== void 0 ? { requiresApproval } : {},
      ...typeof args.options["required-role"] === "string" ? { requiredRole: args.options["required-role"] } : {},
      ...typeof args.options["sla-policy-id"] === "string" ? { slaPolicyId: args.options["sla-policy-id"] } : {}
    };
    const webhook = await client.webhooks.create(workspaceId, {
      connectorId: parseNullableConnectorId(args.options["connector-id"]),
      name,
      path: hookPath,
      targetWorkflowId,
      status: typeof args.options.status === "string" ? args.options.status : void 0,
      eventFilter,
      execution,
      signingSecret
    });
    console.log(JSON.stringify(webhook, null, 2));
    return;
  }
  if (subcommand === "update") {
    if (!webhookId) {
      throw new Error("usage: driftgate webhooks update <webhookId> --workspace <workspaceId> [--name ...]");
    }
    const workspaceId = requireWorkspaceId(args, "usage: driftgate webhooks update <webhookId> --workspace <workspaceId> ...");
    const eventFilterPatch = typeof args.options["event-filter"] === "string" ? await parseJsonObjectOption(args.options["event-filter"], "--event-filter", {}) : void 0;
    const executionPatch = typeof args.options.execution === "string" ? await parseJsonObjectOption(args.options.execution, "--execution", {}) : void 0;
    const requiresApprovalPatch = parseBooleanValue(
      args.options["requires-approval"],
      "--requires-approval"
    );
    const execution = {
      ...executionPatch ?? {},
      ...requiresApprovalPatch !== void 0 ? { requiresApproval: requiresApprovalPatch } : {},
      ...typeof args.options["required-role"] === "string" ? { requiredRole: args.options["required-role"] } : {},
      ...typeof args.options["sla-policy-id"] === "string" ? { slaPolicyId: args.options["sla-policy-id"] } : {}
    };
    const input = {
      ...args.options["connector-id"] !== void 0 ? { connectorId: parseNullableConnectorId(args.options["connector-id"]) } : {},
      ...typeof args.options.name === "string" ? { name: args.options.name } : {},
      ...typeof args.options.path === "string" ? { path: args.options.path } : {},
      ...typeof args.options["target-workflow"] === "string" ? { targetWorkflowId: args.options["target-workflow"] } : {},
      ...typeof args.options.status === "string" ? { status: args.options.status } : {},
      ...eventFilterPatch ? { eventFilter: eventFilterPatch } : {},
      ...Object.keys(execution).length > 0 ? { execution } : {},
      ...typeof args.options["signing-secret"] === "string" ? { signingSecret: args.options["signing-secret"] } : {}
    };
    if (Object.keys(input).length === 0) {
      throw new Error("usage: driftgate webhooks update <webhookId> --workspace <workspaceId> requires at least one field");
    }
    const webhook = await client.webhooks.update(workspaceId, webhookId, input);
    console.log(JSON.stringify(webhook, null, 2));
    return;
  }
  if (subcommand === "delete") {
    if (!webhookId) {
      throw new Error("usage: driftgate webhooks delete <webhookId> --workspace <workspaceId>");
    }
    const workspaceId = requireWorkspaceId(args, "usage: driftgate webhooks delete <webhookId> --workspace <workspaceId>");
    const webhook = await client.webhooks.delete(workspaceId, webhookId);
    console.log(JSON.stringify(webhook, null, 2));
    return;
  }
  throw new Error("usage: driftgate webhooks list|create|update|delete ...");
}
function printHelp() {
  console.log(`driftgate CLI

Commands:
  driftgate login [--api-base <url>]
  driftgate init [--out workflow.yaml] [--force]
  driftgate deploy <workflow.yaml> --workspace <workspaceId> [--project <name>] [--workflow <name>]
  driftgate publish <workflowId> [--yaml workflow.yaml]
  driftgate session start --agent <agent> [--workspace <workspaceId>] [--subject <subject>] [--metadata '{"key":"value"}' | --metadata @metadata.json] [--policy '{"ref":"default","version":"latest"}'] [--route '{"provider":"openai","model":"gpt-4.1-mini","region":"us-east-1"}'] [--risk '{"score":12.5,"decision":"allow"}'] [--workflow-version-id <id>] [--expires-at <ISO-8601>]
  driftgate session execute <sessionId> --input '{"key":"value"}' | --input @input.json [--policy '{"ref":"default","version":"latest"}'] [--route '{"provider":"openai"}'] [--risk '{"score":12.5,"decision":"allow"}'] [--workflow-version-id <id>]
  driftgate execute --agent <agent> --input '{"key":"value"}' | --input @input.json [--workspace <workspaceId>] [--subject <subject>] [--metadata '{"key":"value"}' | --metadata @metadata.json] [--policy '{"ref":"default","version":"latest"}'] [--route '{"provider":"openai"}'] [--risk '{"score":12.5,"decision":"allow"}'] [--workflow-version-id <id>]
  driftgate execution status <executionId>
  driftgate execution events <executionId>
  driftgate execution wait <executionId> [--interval-ms <ms>] [--timeout-ms <ms>]
  driftgate approvals list --workspace <workspaceId> [--status pending|approved|denied]
  driftgate approvals approve <approvalId>
  driftgate approvals deny <approvalId>
  driftgate connectors list --workspace <workspaceId>
  driftgate connectors create --workspace <workspaceId> --name <name> --type <connectorType> [--status active|disabled] [--config '{...}']
  driftgate connectors update <connectorId> --workspace <workspaceId> [--name <name>] [--type <connectorType>] [--status active|disabled] [--config '{...}']
  driftgate connectors delete <connectorId> --workspace <workspaceId>
  driftgate secrets list --workspace <workspaceId>
  driftgate secrets create --workspace <workspaceId> --name <name> --value <value> [--connector-id <id|null>] [--key-version <v>] [--metadata '{...}']
  driftgate secrets update <secretId> --workspace <workspaceId> [--name <name>] [--value <value>] [--connector-id <id|null>] [--key-version <v>] [--metadata '{...}']
  driftgate secrets delete <secretId> --workspace <workspaceId>
  driftgate webhooks list --workspace <workspaceId>
  driftgate webhooks create --workspace <workspaceId> --name <name> --path </hook> --target-workflow <workflowId> --signing-secret <secret> [--connector-id <id|null>] [--status active|disabled] [--event-filter '{...}'] [--execution '{...}'] [--requires-approval true|false] [--required-role <role>] [--sla-policy-id <id>]
  driftgate webhooks update <webhookId> --workspace <workspaceId> [--name <name>] [--path </hook>] [--target-workflow <workflowId>] [--status active|disabled] [--event-filter '{...}'] [--execution '{...}'] [--requires-approval true|false] [--required-role <role>] [--sla-policy-id <id>] [--signing-secret <secret>] [--connector-id <id|null>]
  driftgate webhooks delete <webhookId> --workspace <workspaceId>

Removed in V4 CLI:
  driftgate run ...
  driftgate status ...
`);
}
void main().catch((error) => {
  console.error(JSON.stringify(renderErrorEnvelope(error), null, 2));
  process.exitCode = 1;
});
//# sourceMappingURL=index.js.map