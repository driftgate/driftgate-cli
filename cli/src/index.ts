#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  DriftGateClient,
  DriftGateError,
  type DriftGateCanonicalResponse,
  type DriftGateEphemeralExecuteInput,
  type DriftGateSessionExecuteInput,
  type DriftGateSessionStartInput
} from "@driftgate/sdk";
import { compileWorkflowYaml } from "@driftgate/workflow-compiler";

type CliConfig = {
  baseUrl: string;
  sessionToken?: string;
  apiKey?: string;
  expiresAt?: string;
};

type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | true>;
};

const REQUIRED_V4_ERROR_CODES = new Set([
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

async function main(): Promise<void> {
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
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function parseArgs(input: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};

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

function resolveBaseUrl(args: ParsedArgs, config?: CliConfig): string {
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

function getConfigDir(): string {
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

function getConfigPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

async function loadConfig(): Promise<CliConfig | null> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as CliConfig;
}

async function saveConfig(config: CliConfig): Promise<void> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2));
}

function buildClient(baseUrl: string, config: CliConfig | null): DriftGateClient {
  const apiKey = process.env.DRIFTGATE_API_KEY ?? config?.apiKey;
  const sessionToken = apiKey ? undefined : process.env.DRIFTGATE_SESSION_TOKEN ?? config?.sessionToken;

  if (!apiKey && !sessionToken) {
    throw new Error("no credentials found; run `driftgate login` or set DRIFTGATE_API_KEY");
  }

  return new DriftGateClient({
    baseUrl,
    apiKey,
    sessionToken
  });
}

function requireWorkspaceId(args: ParsedArgs, usage: string): string {
  const workspaceId =
    (typeof args.options.workspace === "string" && args.options.workspace) ||
    process.env.DRIFTGATE_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error(usage);
  }
  return workspaceId;
}

function parseBooleanValue(value: string | true | undefined, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
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

async function parseJsonObjectOption(
  value: string | true | undefined,
  label: string,
  fallback: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseNullableConnectorId(value: string | true | undefined): string | null | undefined {
  if (value === undefined || value === true) {
    return undefined;
  }
  if (value.trim().toLowerCase() === "null") {
    return null;
  }
  return value;
}

function optionString(value: string | true | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deprecatedCommandError(command: string, replacement: string): Error {
  return new Error(`command '${command}' was removed in V4 CLI; use '${replacement}'`);
}

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function elapsedMs(startNs: bigint): number {
  const elapsed = process.hrtime.bigint() - startNs;
  return Number((Number(elapsed) / 1_000_000).toFixed(3));
}

function parseNumberOption(
  value: string | true | undefined,
  label: string,
  { integer = false, minimum }: { integer?: boolean; minimum?: number } = {}
): number | undefined {
  const raw = optionString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  if (minimum !== undefined && parsed < minimum) {
    throw new Error(`${label} must be >= ${minimum}`);
  }
  return parsed;
}

async function parseRequiredInputOption(args: ParsedArgs): Promise<Record<string, unknown>> {
  const rawInput = optionString(args.options.input);
  if (!rawInput) {
    throw new Error("usage: --input '{...}' or --input @input.json is required");
  }
  const source = rawInput.startsWith("@") ? await readFile(rawInput.slice(1), "utf8") : rawInput;
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must parse to a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function parsePolicyOption(
  args: ParsedArgs
): Promise<DriftGateSessionStartInput["policy"] | undefined> {
  const policyOption = optionString(args.options.policy);
  if (policyOption) {
    const value = await parseJsonObjectOption(policyOption, "--policy", {});
    const ref = typeof value.ref === "string" ? value.ref : undefined;
    const version = typeof value.version === "string" ? value.version : undefined;
    if (!ref || !version) {
      throw new Error("--policy requires JSON object with string fields 'ref' and 'version'");
    }
    return { ref, version };
  }

  const ref = optionString(args.options["policy-ref"]);
  const version = optionString(args.options["policy-version"]);
  if (!ref && !version) {
    return undefined;
  }
  if (!ref || !version) {
    throw new Error("--policy-ref and --policy-version must be provided together");
  }
  return { ref, version };
}

async function parseRouteOption(
  args: ParsedArgs
): Promise<DriftGateSessionStartInput["route"] | undefined> {
  const routeOption = optionString(args.options.route);
  if (routeOption) {
    const value = await parseJsonObjectOption(routeOption, "--route", {});
    const provider = typeof value.provider === "string" ? value.provider : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    const region = typeof value.region === "string" ? value.region : undefined;
    if (!provider && !model && !region) {
      throw new Error("--route requires at least one of provider/model/region");
    }
    return { provider, model, region };
  }

  const provider = optionString(args.options["route-provider"]);
  const model = optionString(args.options["route-model"]);
  const region = optionString(args.options["route-region"]);
  if (!provider && !model && !region) {
    return undefined;
  }
  return { provider, model, region };
}

async function parseRiskOption(
  args: ParsedArgs
): Promise<DriftGateSessionStartInput["risk"] | undefined> {
  const riskOption = optionString(args.options.risk);
  if (riskOption) {
    const value = await parseJsonObjectOption(riskOption, "--risk", {});
    const score = typeof value.score === "number" ? value.score : undefined;
    const decision =
      value.decision === "allow" || value.decision === "deny" || value.decision === "review"
        ? value.decision
        : undefined;
    if (score === undefined && decision === undefined) {
      throw new Error("--risk requires at least one of score/decision");
    }
    return { score, decision };
  }

  const score = parseNumberOption(args.options["risk-score"], "--risk-score");
  const decisionRaw = optionString(args.options["risk-decision"]);
  if (decisionRaw && !["allow", "deny", "review"].includes(decisionRaw)) {
    throw new Error("--risk-decision must be one of: allow|deny|review");
  }
  const decision = decisionRaw as "allow" | "deny" | "review" | undefined;
  if (score === undefined && decision === undefined) {
    return undefined;
  }
  return { score, decision };
}

async function parseV4ExecutionDefaults(
  args: ParsedArgs
): Promise<Pick<DriftGateSessionExecuteInput, "policy" | "route" | "risk" | "workflowVersionId">> {
  return {
    policy: await parsePolicyOption(args),
    route: await parseRouteOption(args),
    risk: await parseRiskOption(args),
    workflowVersionId: optionString(args.options["workflow-version-id"])
  };
}

function canonicalOutput<T>(response: DriftGateCanonicalResponse<T>): {
  ok: boolean;
  data: T | null;
  meta: DriftGateCanonicalResponse<T>["meta"];
  error: DriftGateCanonicalResponse<T>["error"];
} {
  return {
    ok: response.ok,
    data: response.data,
    meta: response.meta,
    error: response.error
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function mapStableErrorCode(inputCode: string, status: number): string {
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

function renderErrorEnvelope(error: unknown): {
  ok: false;
  data: null;
  meta: { requestId: string; timingMs: { total: number } };
  error: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
} {
  if (error instanceof DriftGateError) {
    const code = mapStableErrorCode(error.code, error.status);
    const retryable =
      code === "RATE_LIMITED" || code === "TIMEOUT" || error.status >= 500 || error.status === 429;
    return {
      ok: false,
      data: null,
      meta: {
        requestId: error.correlationId ?? `cli_${randomUUID()}`,
        timingMs: { total: 0 }
      },
      error: {
        code,
        message: error.message,
        status: error.status,
        retryable,
        ...(error.details && typeof error.details === "object"
          ? { details: error.details as Record<string, unknown> }
          : {})
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

async function handleLogin(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const existingConfig = await loadConfig();
  const baseUrl = resolveBaseUrl(args, existingConfig ?? undefined);

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
      ...(auth0Audience ? { audience: auth0Audience } : {})
    })
  });

  if (!deviceCodeResponse.ok) {
    const body = await deviceCodeResponse.text();
    throw new Error(`device-code start failed (${deviceCodeResponse.status}): ${body}`);
  }

  const deviceBody = (await deviceCodeResponse.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };

  console.log("Complete DriftGate login in your browser:");
  console.log(deviceBody.verification_uri_complete ?? deviceBody.verification_uri);
  console.log(`User code: ${deviceBody.user_code}`);

  const tokenEndpoint = `https://${auth0Domain}/oauth/token`;
  const pollIntervalMs = (deviceBody.interval ?? 5) * 1_000;
  const timeoutAt = Date.now() + deviceBody.expires_in * 1_000;

  let idToken: string | null = null;
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

    const tokenJson = (await tokenResponse.json()) as {
      access_token?: string;
      id_token?: string;
      error?: string;
      error_description?: string;
    };

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
    expiresAt: typeof exchangeBody.expiresAt === "string" ? exchangeBody.expiresAt : undefined
  });
  console.log("Device-code login successful. Session token stored for DriftGate CLI.");
}

async function handleInit(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const outputPath =
    (typeof args.options["out"] === "string" && args.options["out"]) || "workflow.yaml";

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

async function handleDeploy(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [yamlPath] = args.positionals;
  if (!yamlPath) {
    throw new Error("usage: driftgate deploy <workflow.yaml> [--workspace <workspaceId>] [--project <name>] [--workflow <name>]");
  }

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);

  const workflowYaml = await readFile(yamlPath, "utf8");
  const compiled = compileWorkflowYaml(workflowYaml);
  const workspaceId =
    (typeof args.options.workspace === "string" && args.options.workspace) ||
    process.env.DRIFTGATE_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error("workspace id is required (--workspace or DRIFTGATE_WORKSPACE_ID)");
  }

  const response = await client.deployWorkflow({
    workspaceId,
    projectName:
      (typeof args.options.project === "string" && args.options.project) || compiled.workflow.metadata.name,
    workflowName:
      (typeof args.options.workflow === "string" && args.options.workflow) || compiled.workflow.metadata.name,
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

async function handlePublish(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [workflowId] = args.positionals;
  if (!workflowId) {
    throw new Error("usage: driftgate publish <workflowId> [--yaml <workflow.yaml>]");
  }

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);

  const yamlPath = typeof args.options.yaml === "string" ? args.options.yaml : null;
  const workflowYaml = yamlPath ? await readFile(yamlPath, "utf8") : undefined;
  const version = await client.publishWorkflow(workflowId, workflowYaml);

  console.log(JSON.stringify(version, null, 2));
}

async function handleSession(rest: string[]): Promise<void> {
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

async function handleSessionStart(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);
  const agent = optionString(args.options.agent);
  if (!agent) {
    throw new Error(
      "usage: driftgate session start --agent <agent> [--workspace <workspaceId>] [--metadata '{...}'] [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>] [--expires-at <ISO-8601>]"
    );
  }

  const metadata =
    typeof args.options.metadata === "string"
      ? await parseJsonObjectOption(args.options.metadata, "--metadata", {})
      : undefined;
  const workspaceId = optionString(args.options.workspace) ?? process.env.DRIFTGATE_WORKSPACE_ID;
  const input: DriftGateSessionStartInput = {
    ...(workspaceId ? { workspaceId } : {}),
    agent,
    ...(optionString(args.options.subject) ? { subject: optionString(args.options.subject) } : {}),
    ...(metadata ? { metadata } : {}),
    ...(await parseV4ExecutionDefaults(args)),
    ...(optionString(args.options["expires-at"]) ? { expiresAt: optionString(args.options["expires-at"]) } : {})
  };

  const session = await client.session.start(input);
  printJson(canonicalOutput(session.startEnvelope));
}

async function handleSessionExecute(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [sessionId] = args.positionals;
  if (!sessionId) {
    throw new Error(
      "usage: driftgate session execute <sessionId> --input '{...}' [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>]"
    );
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);
  const input: DriftGateSessionExecuteInput = {
    input: await parseRequiredInputOption(args),
    ...(await parseV4ExecutionDefaults(args))
  };
  const response = await client.executeSession(sessionId, input);
  printJson(canonicalOutput(response));
}

async function handleExecute(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);
  const agent = optionString(args.options.agent);
  if (!agent) {
    throw new Error(
      "usage: driftgate execute --agent <agent> --input '{...}' [--workspace <workspaceId>] [--metadata '{...}'] [--policy '{...}'] [--route '{...}'] [--risk '{...}'] [--workflow-version-id <id>]"
    );
  }
  const metadata =
    typeof args.options.metadata === "string"
      ? await parseJsonObjectOption(args.options.metadata, "--metadata", {})
      : undefined;
  const workspaceId = optionString(args.options.workspace) ?? process.env.DRIFTGATE_WORKSPACE_ID;
  const input: DriftGateEphemeralExecuteInput = {
    ...(workspaceId ? { workspaceId } : {}),
    agent,
    ...(optionString(args.options.subject) ? { subject: optionString(args.options.subject) } : {}),
    ...(metadata ? { metadata } : {}),
    ...(await parseV4ExecutionDefaults(args)),
    input: await parseRequiredInputOption(args)
  };
  const response = await client.execute(input);
  printJson(canonicalOutput(response));
}

async function handleExecution(rest: string[]): Promise<void> {
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

async function handleExecutionStatus(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [executionId] = args.positionals;
  if (!executionId) {
    throw new Error("usage: driftgate execution status <executionId>");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);
  const startedAtNs = nowNs();
  const response = await client.status(executionId);
  const events = await client.events(executionId);
  const requestId =
    typeof response.run.correlationId === "string" && response.run.correlationId.length > 0
      ? response.run.correlationId
      : `cli_${randomUUID()}`;

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

async function handleExecutionEvents(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [executionId] = args.positionals;
  if (!executionId) {
    throw new Error("usage: driftgate execution events <executionId>");
  }
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
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

async function handleExecutionWait(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [executionId] = args.positionals;
  if (!executionId) {
    throw new Error("usage: driftgate execution wait <executionId> [--interval-ms <ms>] [--timeout-ms <ms>]");
  }

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
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
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  });
  const requestId =
    typeof response.run.correlationId === "string" && response.run.correlationId.length > 0
      ? response.run.correlationId
      : `cli_${randomUUID()}`;

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

async function handleApprovals(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [subcommand, subject] = args.positionals;

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
  const client = buildClient(baseUrl, config);

  if (subcommand === "list") {
    const workspaceId =
      (typeof args.options.workspace === "string" && args.options.workspace) ||
      process.env.DRIFTGATE_WORKSPACE_ID;
    if (!workspaceId) {
      throw new Error("usage: driftgate approvals list --workspace <workspaceId>");
    }

    const status =
      typeof args.options.status === "string"
        ? (args.options.status as "pending" | "approved" | "denied")
        : undefined;
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

async function handleConnectors(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [subcommand, connectorId] = args.positionals;

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
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
    const status =
      typeof args.options.status === "string" ? (args.options.status as "active" | "disabled") : undefined;
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
    const configPatch =
      typeof args.options.config === "string"
        ? await parseJsonObjectOption(args.options.config, "--config", {})
        : undefined;
    const input = {
      ...(typeof args.options.name === "string" ? { name: args.options.name } : {}),
      ...(typeof args.options.type === "string" ? { connectorType: args.options.type } : {}),
      ...(typeof args.options.status === "string"
        ? { status: args.options.status as "active" | "disabled" }
        : {}),
      ...(configPatch ? { config: configPatch } : {})
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

async function handleSecrets(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [subcommand, secretId] = args.positionals;

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
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
      keyVersion: typeof args.options["key-version"] === "string" ? args.options["key-version"] : undefined,
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
    const metadataPatch =
      typeof args.options.metadata === "string"
        ? await parseJsonObjectOption(args.options.metadata, "--metadata", {})
        : undefined;
    const input = {
      ...(typeof args.options.name === "string" ? { name: args.options.name } : {}),
      ...(typeof args.options.value === "string" ? { value: args.options.value } : {}),
      ...(args.options["connector-id"] !== undefined
        ? { connectorId: parseNullableConnectorId(args.options["connector-id"]) }
        : {}),
      ...(typeof args.options["key-version"] === "string" ? { keyVersion: args.options["key-version"] } : {}),
      ...(metadataPatch ? { metadata: metadataPatch } : {})
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

async function handleWebhooks(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const [subcommand, webhookId] = args.positionals;

  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(args, config ?? undefined);
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
    const targetWorkflowId =
      typeof args.options["target-workflow"] === "string" ? args.options["target-workflow"] : "";
    const signingSecret =
      typeof args.options["signing-secret"] === "string" ? args.options["signing-secret"] : "";
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
      ...(requiresApproval !== undefined ? { requiresApproval } : {}),
      ...(typeof args.options["required-role"] === "string"
        ? { requiredRole: args.options["required-role"] }
        : {}),
      ...(typeof args.options["sla-policy-id"] === "string"
        ? { slaPolicyId: args.options["sla-policy-id"] }
        : {})
    };

    const webhook = await client.webhooks.create(workspaceId, {
      connectorId: parseNullableConnectorId(args.options["connector-id"]),
      name,
      path: hookPath,
      targetWorkflowId,
      status:
        typeof args.options.status === "string" ? (args.options.status as "active" | "disabled") : undefined,
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
    const eventFilterPatch =
      typeof args.options["event-filter"] === "string"
        ? await parseJsonObjectOption(args.options["event-filter"], "--event-filter", {})
        : undefined;
    const executionPatch =
      typeof args.options.execution === "string"
        ? await parseJsonObjectOption(args.options.execution, "--execution", {})
        : undefined;
    const requiresApprovalPatch = parseBooleanValue(
      args.options["requires-approval"],
      "--requires-approval"
    );

    const execution = {
      ...(executionPatch ?? {}),
      ...(requiresApprovalPatch !== undefined ? { requiresApproval: requiresApprovalPatch } : {}),
      ...(typeof args.options["required-role"] === "string"
        ? { requiredRole: args.options["required-role"] }
        : {}),
      ...(typeof args.options["sla-policy-id"] === "string"
        ? { slaPolicyId: args.options["sla-policy-id"] }
        : {})
    };

    const input = {
      ...(args.options["connector-id"] !== undefined
        ? { connectorId: parseNullableConnectorId(args.options["connector-id"]) }
        : {}),
      ...(typeof args.options.name === "string" ? { name: args.options.name } : {}),
      ...(typeof args.options.path === "string" ? { path: args.options.path } : {}),
      ...(typeof args.options["target-workflow"] === "string"
        ? { targetWorkflowId: args.options["target-workflow"] }
        : {}),
      ...(typeof args.options.status === "string"
        ? { status: args.options.status as "active" | "disabled" }
        : {}),
      ...(eventFilterPatch ? { eventFilter: eventFilterPatch } : {}),
      ...(Object.keys(execution).length > 0 ? { execution } : {}),
      ...(typeof args.options["signing-secret"] === "string"
        ? { signingSecret: args.options["signing-secret"] }
        : {})
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

function printHelp(): void {
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

void main().catch((error: unknown) => {
  console.error(JSON.stringify(renderErrorEnvelope(error), null, 2));
  process.exitCode = 1;
});
