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
  number: number;
  id: string;
  repo: string;
  fields: Record<string, FieldConfig>;
}

interface Config {
  owner: string;
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
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
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
    const owner = await ask(rl, "Owner (org or username)", "evolutionaryherbalism");

    console.log(`\nFetching projects for "${owner}"...`);
    const data = await ghJSON([
      "project", "list", "--owner", owner, "--format", "json", "--limit", "100",
    ]);

    const projects: Record<string, ProjectConfig> = {};

    for (const proj of data.projects) {
      console.log(`\n  #${proj.number}: ${proj.title}`);
      const alias = await ask(rl, "  Alias (blank to skip)");
      if (!alias) continue;

      const repo = await ask(rl, "  Default repo name", alias);

      console.log(`  Fetching fields for #${proj.number}...`);
      const fields = await graphqlFields(owner, proj.number);

      projects[alias] = {
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

    const config: Config = { owner, projects };
    saveConfig(config);
    console.log(`\nConfig written to ${CONFIG_FILE}`);
  } finally {
    rl.close();
  }
}

async function cmdSync() {
  const config = loadConfig();
  console.log(`Syncing projects for "${config.owner}"...`);

  const data = await ghJSON([
    "project", "list", "--owner", config.owner, "--format", "json", "--limit", "100",
  ]);

  // Build a lookup from project number to latest data
  const latest = new Map<number, any>();
  for (const proj of data.projects) {
    latest.set(proj.number, proj);
  }

  for (const [alias, proj] of Object.entries(config.projects)) {
    const fresh = latest.get(proj.number);
    if (!fresh) {
      console.log(`  Warning: project #${proj.number} ("${alias}") not found, keeping stale config`);
      continue;
    }

    proj.id = fresh.id;

    console.log(`  Refreshing fields for "${alias}" (#${proj.number})...`);
    proj.fields = await graphqlFields(config.owner, proj.number);
  }

  saveConfig(config);
  console.log(`Config updated: ${CONFIG_FILE}`);
}

async function cmdAdd(alias: string, issueNum: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);
  const url = `https://github.com/${config.owner}/${proj.repo}/issues/${issueNum}`;

  const result = await ghJSON([
    "project", "item-add", String(proj.number),
    "--owner", config.owner,
    "--url", url,
    "--format", "json",
  ]);

  console.log(`Added issue #${issueNum} to "${alias}" (item ${result.id})`);
}

async function cmdStatus(alias: string, issueNum: string, statusName: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);

  const statusField = proj.fields["Status"];
  if (!statusField) die(`No "Status" field found for "${alias}". Run "gh p sync".`);

  const optionId = statusField.options[statusName];
  if (!optionId) {
    const available = Object.keys(statusField.options).join(", ");
    die(`Unknown status "${statusName}". Available: ${available}`);
  }

  // Find item ID
  const data = await ghJSON([
    "project", "item-list", String(proj.number),
    "--owner", config.owner,
    "--format", "json",
    "--limit", "500",
  ]);

  const num = parseInt(issueNum, 10);
  const repoFullName = `${config.owner}/${proj.repo}`;
  const item = data.items.find(
    (i: any) => i.content?.number === num && i.content?.repository === repoFullName
  );

  if (!item) die(`Issue #${issueNum} not found in project "${alias}". Did you add it first?`);

  await gh([
    "project", "item-edit",
    "--id", item.id,
    "--project-id", proj.id,
    "--field-id", statusField.id,
    "--single-select-option-id", optionId,
  ]);

  console.log(`Set #${issueNum} status to "${statusName}"`);
}

async function cmdList(alias: string, statusFilter?: string) {
  const config = loadConfig();
  const proj = getProject(config, alias);

  const data = await ghJSON([
    "project", "item-list", String(proj.number),
    "--owner", config.owner,
    "--format", "json",
    "--limit", "500",
  ]);

  let items: any[] = data.items.filter((i: any) => i.content?.number != null);

  // Extract status from fieldValues if available
  const statusFieldId = proj.fields["Status"]?.id;

  const rows: { num: number; title: string; status: string }[] = [];
  for (const item of items) {
    const num = item.content.number;
    const title = item.content.title;

    // Find status in fieldValues
    let status = "";
    if (item.fieldValues?.nodes) {
      for (const fv of item.fieldValues.nodes) {
        if (fv.field?.id === statusFieldId || fv.field?.name === "Status") {
          status = fv.name ?? fv.value ?? "";
          break;
        }
      }
    }

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
    console.log(`  #${n}  ${t}  ${r.status}`);
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
  init                                   Interactive setup — configure projects and aliases
  sync                                   Refresh cached IDs and field options from GitHub
  add <alias> <issue-number>             Add an issue to a project
  status <alias> <issue-number> <name>   Set the status of an issue
  list <alias> [--status <name>]         List project items
  statuses <alias>                       Show available status options`);
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
  case "add":
    if (args.length < 2) die("Usage: gh p add <alias> <issue-number>");
    await cmdAdd(args[0], args[1]);
    break;
  case "status":
    if (args.length < 3) die("Usage: gh p status <alias> <issue-number> <status-name>");
    await cmdStatus(args[0], args[1], args.slice(2).join(" "));
    break;
  case "list": {
    if (args.length < 1) die("Usage: gh p list <alias> [--status <name>]");
    const statusIdx = args.indexOf("--status");
    const filter = statusIdx >= 0 ? args.slice(statusIdx + 1).join(" ") : undefined;
    await cmdList(args[0], filter);
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
