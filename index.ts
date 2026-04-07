#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline/promises";

// --- Types ---

interface FieldConfig {
  id: string;
  options: Record<string, string>;
}

interface ProjectConfig {
  owner: string;
  number: number;
  id: string;
  repo: string;
  fields: Record<string, FieldConfig>;
}

interface Config {
  defaultOwner: string;
  projects: Record<string, ProjectConfig>;
}

// --- Paths ---

const CONFIG_DIR = join(homedir(), ".config", "ghp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// --- Helpers ---

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function gh(args: string[], throwOnError = false): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    if (throwOnError) throw new Error(stderr.trim());
    die(`gh ${args.join(" ")} failed:\n${stderr.trim()}`);
  }
  return stdout.trim();
}

async function ghJSON(args: string[], throwOnError = false): Promise<any> {
  const out = await gh(args, throwOnError);
  return JSON.parse(out);
}

async function graphqlFields(owner: string, number: number): Promise<Record<string, FieldConfig>> {
  const query = `
    query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          fields(first: 100) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
              ... on ProjectV2IterationField {
                id
                name
              }
              ... on ProjectV2Field {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const userQuery = query.replace("organization(login: $owner)", "user(login: $owner)");

  let data: any;
  try {
    data = await ghJSON([
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-F", `number=${number}`,
    ], true);
  } catch {
    // Fallback: try as user instead of org
    data = await ghJSON([
      "api", "graphql",
      "-f", `query=${userQuery}`,
      "-f", `owner=${owner}`,
      "-F", `number=${number}`,
    ]);
  }

  const project = data.data?.organization?.projectV2 ?? data.data?.user?.projectV2;
  if (!project) die(`Could not find project #${number} for owner "${owner}"`);

  const fields: Record<string, FieldConfig> = {};
  for (const node of project.fields.nodes) {
    if (node.options) {
      const opts: Record<string, string> = {};
      for (const opt of node.options) {
        opts[opt.name] = opt.id;
      }
      fields[node.name] = { id: node.id, options: opts };
    }
  }
  return fields;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    die(`No config found. Run "gh p init" first.`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  // Migrate old format: top-level "owner" → "defaultOwner" + per-project owner
  if (raw.owner && !raw.defaultOwner) {
    raw.defaultOwner = raw.owner;
    delete raw.owner;
    for (const proj of Object.values(raw.projects) as any[]) {
      if (!proj.owner) proj.owner = raw.defaultOwner;
    }
    saveConfig(raw);
  }
  return raw;
}

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

function getProject(config: Config, alias: string): ProjectConfig {
  const proj = config.projects[alias];
  if (!proj) {
    const available = Object.keys(config.projects).join(", ");
    die(`Unknown project "${alias}". Available: ${available || "(none — run gh p init)"}`);
  }
  return proj;
}

async function ask(rl: any, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultVal || "";
}

// --- Commands ---

async function cmdInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Load existing config or start fresh
    let config: Config;
    if (existsSync(CONFIG_FILE)) {
      config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      // Migrate old format: top-level owner → per-project owner
      if ((config as any).owner && !config.defaultOwner) {
        config.defaultOwner = (config as any).owner;
        delete (config as any).owner;
        for (const proj of Object.values(config.projects)) {
          if (!proj.owner) proj.owner = config.defaultOwner;
        }
      }
      console.log(`Existing config found. Adding projects to existing config.`);
    } else {
      config = { defaultOwner: "evolutionaryherbalism", projects: {} };
    }

    const owner = await ask(rl, "Owner (org or username)", config.defaultOwner);

    console.log(`\nFetching projects for "${owner}"...`);
    const data = await ghJSON([
      "project", "list", "--owner", owner, "--format", "json", "--limit", "100",
    ]);

    for (const proj of data.projects) {
      console.log(`\n  #${proj.number}: ${proj.title}`);
      const alias = await ask(rl, "  Alias (blank to skip)");
      if (!alias) continue;

      const repo = await ask(rl, "  Default repo name", alias);

      console.log(`  Fetching fields for #${proj.number}...`);
      const fields = await graphqlFields(owner, proj.number);

      config.projects[alias] = {
        owner,
        number: proj.number,
        id: proj.id,
        repo,
        fields,
      };

      const fieldNames = Object.keys(fields);
      if (fieldNames.length > 0) {
        console.log(`  Found fields: ${fieldNames.join(", ")}`);
      }
    }

    saveConfig(config);
    console.log(`\nConfig written to ${CONFIG_FILE}`);
  } finally {
    rl.close();
  }
}

async function cmdSync() {
  const config = loadConfig();

  // Group projects by owner to minimize API calls
  const byOwner = new Map<string, [string, ProjectConfig][]>();
  for (const [alias, proj] of Object.entries(config.projects)) {
    const owner = proj.owner ?? config.defaultOwner;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner)!.push([alias, proj]);
  }

  for (const [owner, entries] of byOwner) {
    console.log(`Syncing projects for "${owner}"...`);

    const data = await ghJSON([
      "project", "list", "--owner", owner, "--format", "json", "--limit", "100",
    ]);

    const latest = new Map<number, any>();
    for (const proj of data.projects) {
      latest.set(proj.number, proj);
    }

    for (const [alias, proj] of entries) {
      const fresh = latest.get(proj.number);
      if (!fresh) {
        console.log(`  Warning: project #${proj.number} ("${alias}") not found, keeping stale config`);
        continue;
      }

      proj.id = fresh.id;

      console.log(`  Refreshing fields for "${alias}" (#${proj.number})...`);
      proj.fields = await graphqlFields(owner, proj.number);
    }
  }

  saveConfig(config);
  console.log(`Config updated: ${CONFIG_FILE}`);
}

function resolveFieldOption(proj: ProjectConfig, fieldName: string, optionName: string): { field: FieldConfig; optionId: string } {
  const field = proj.fields[fieldName];
  if (!field) die(`No "${fieldName}" field found. Run "gh p sync".`);
  const optionId = field.options[optionName];
  if (!optionId) {
    const available = Object.keys(field.options).join(", ");
    die(`Unknown ${fieldName.toLowerCase()} "${optionName}". Available: ${available}`);
  }
  return { field, optionId };
}

async function setItemField(proj: ProjectConfig, itemId: string, fieldId: string, optionId: string) {
  await gh([
    "project", "item-edit",
    "--id", itemId,
    "--project-id", proj.id,
    "--field-id", fieldId,
    "--single-select-option-id", optionId,
  ]);
}

async function findItemId(proj: ProjectConfig, owner: string, issueNum: string): Promise<string> {
  const num = parseInt(issueNum, 10);
  const repoFullName = `${owner}/${proj.repo}`;
  // Retry: item-list can lag immediately after item-add
  const delays = [0, 500, 1500, 3000];
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const data = await ghJSON([
      "project", "item-list", String(proj.number),
      "--owner", owner,
      "--format", "json",
      "--limit", "500",
    ]);
    const item = data.items.find(
      (i: any) => i.content?.number === num && i.content?.repository === repoFullName
    );
    if (item) return item.id;
  }
  die(`Issue #${issueNum} not found in project "${proj.repo}". Did you add it first?`);
}

async function cmdAdd(alias: string, issueNum: string, statusName?: string, priorityName?: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const url = `https://github.com/${owner}/${proj.repo}/issues/${issueNum}`;

  const result = await ghJSON([
    "project", "item-add", String(proj.number),
    "--owner", owner,
    "--url", url,
    "--format", "json",
  ]);

  console.log(`Added issue #${issueNum} to "${alias}" (item ${result.id})`);

  if (statusName) {
    const { field, optionId } = resolveFieldOption(proj, "Status", statusName);
    await setItemField(proj, result.id, field.id, optionId);
    console.log(`Set #${issueNum} status to "${statusName}"`);
  }
  if (priorityName) {
    const { field, optionId } = resolveFieldOption(proj, "Priority", priorityName);
    await setItemField(proj, result.id, field.id, optionId);
    console.log(`Set #${issueNum} priority to "${priorityName}"`);
  }
}

async function cmdStatus(alias: string, issueNum: string, statusName: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const { field, optionId } = resolveFieldOption(proj, "Status", statusName);
  const itemId = await findItemId(proj, owner, issueNum);
  await setItemField(proj, itemId, field.id, optionId);
  console.log(`Set #${issueNum} status to "${statusName}"`);
}

async function cmdPriority(alias: string, issueNum: string, priorityName: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;
  const { field, optionId } = resolveFieldOption(proj, "Priority", priorityName);
  const itemId = await findItemId(proj, owner, issueNum);
  await setItemField(proj, itemId, field.id, optionId);
  console.log(`Set #${issueNum} priority to "${priorityName}"`);
}

async function fetchItemStatuses(owner: string, projectNumber: number): Promise<Map<number, string>> {
  const query = `
    query($owner: String!, $number: Int!, $cursor: String) {
      user(login: $owner) {
        projectV2(number: $number) {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              content { ... on Issue { number } ... on PullRequest { number } }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                }
              }
            }
          }
        }
      }
    }
  `;

  const statusMap = new Map<number, string>();
  let cursor: string | null = null;

  while (true) {
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-F", `number=${projectNumber}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);

    const data = await ghJSON(args);
    const items = data.data?.user?.projectV2?.items;
    if (!items) break;

    for (const node of items.nodes) {
      const num = node.content?.number;
      if (!num) continue;
      for (const fv of node.fieldValues.nodes) {
        if (fv.field?.name === "Status" && fv.name) {
          statusMap.set(num, fv.name);
        }
      }
    }

    if (!items.pageInfo.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }

  return statusMap;
}

async function cmdList(alias: string, statusFilter?: string, verbose = false) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const owner = proj.owner ?? config.defaultOwner;

  const data = await ghJSON([
    "project", "item-list", String(proj.number),
    "--owner", owner,
    "--format", "json",
    "--limit", "500",
  ]);

  let items: any[] = data.items.filter((i: any) => i.content?.number != null);

  // Fetch statuses via GraphQL only when needed
  const statusMap = (verbose || statusFilter)
    ? await fetchItemStatuses(owner, proj.number)
    : new Map<number, string>();

  const rows: { num: number; title: string; status: string }[] = [];
  for (const item of items) {
    const num = item.content.number;
    const title = item.content.title;
    const status = statusMap.get(num) ?? "";

    if (statusFilter && status.toLowerCase() !== statusFilter.toLowerCase()) continue;
    rows.push({ num, title, status });
  }

  if (rows.length === 0) {
    console.log(statusFilter ? `No items with status "${statusFilter}"` : "No items found");
    return;
  }

  // Print aligned table
  const numWidth = Math.max(1, ...rows.map((r) => String(r.num).length));
  const titleWidth = Math.max(5, ...rows.map((r) => r.title.length));

  for (const r of rows) {
    const n = String(r.num).padStart(numWidth);
    const t = r.title.padEnd(titleWidth);
    const s = r.status ? `  ${r.status}` : "";
    console.log(`  #${n}  ${t}${s}`);
  }
}

async function cmdStatuses(alias: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);

  const statusField = proj.fields["Status"];
  if (!statusField) die(`No "Status" field found for "${alias}".`);

  console.log(`Status options for "${alias}":`);
  for (const name of Object.keys(statusField.options)) {
    console.log(`  ${name}`);
  }
}

// --- Usage ---

function usage() {
  console.log(`Usage: gh p <command>

Commands:
  init                                                Interactive setup — add projects from any owner
  sync                                                Refresh cached IDs and field options from GitHub
  add <alias> <issue> [--status <s>] [--priority <p>] Add an issue to a project (optionally set status/priority)
  status <alias> <issue> <name>                       Set the status of an issue
  priority <alias> <issue> <name>                     Set the priority of an issue
  list <alias> [-v] [--status <name>]                 List project items (-v shows status)
  statuses <alias>                                    Show available status options`);
}

function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val;
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "sync":
    await cmdSync();
    break;
  case "add": {
    const addArgs = [...args];
    const statusFlag = takeFlag(addArgs, "--status");
    const priorityFlag = takeFlag(addArgs, "--priority");
    if (addArgs.length < 2) die("Usage: gh p add <alias> <issue-number> [--status <name>] [--priority <name>]");
    await cmdAdd(addArgs[0], addArgs[1], statusFlag, priorityFlag);
    break;
  }
  case "status":
    if (args.length < 3) die("Usage: gh p status <alias> <issue-number> <status-name>");
    await cmdStatus(args[0], args[1], args.slice(2).join(" "));
    break;
  case "priority":
    if (args.length < 3) die("Usage: gh p priority <alias> <issue-number> <P0|P1|P2>");
    await cmdPriority(args[0], args[1], args.slice(2).join(" "));
    break;
  case "list": {
    if (args.length < 1) die("Usage: gh p list <alias> [-v] [--status <name>]");
    const verbose = args.includes("-v") || args.includes("--verbose");
    const filtered = args.filter(a => a !== "-v" && a !== "--verbose");
    const statusIdx = filtered.indexOf("--status");
    const filter = statusIdx >= 0 ? filtered.slice(statusIdx + 1).join(" ") : undefined;
    await cmdList(filtered[0], filter, verbose);
    break;
  }
  case "statuses":
    if (args.length < 1) die("Usage: gh p statuses <alias>");
    await cmdStatuses(args[0]);
    break;
  default:
    usage();
    if (cmd && cmd !== "--help" && cmd !== "-h" && cmd !== "help") process.exit(1);
    break;
}
