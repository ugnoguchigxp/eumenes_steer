import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { name, version } from "../package.json";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(cwd: string, ...cmd: string[]) {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) throw new Error(`Command failed: ${cmd.join(" ")}`);
}

const temp = await mkdtemp(join(tmpdir(), "eumenes-steer-pack-"));
try {
  run(root, "bun", "pm", "pack", "--destination", temp, "--ignore-scripts");
  const tarball = join(temp, `${name}-${version}.tgz`);
  const archive = Bun.spawnSync({ cmd: ["tar", "-tzf", tarball] });
  if (!archive.success) throw new Error(archive.stderr.toString());
  const files = archive.stdout.toString().trim().split("\n").sort();
  const expected = [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
    "package/src/contracts.ts",
    "package/src/inbox.ts",
    "package/src/index.ts",
  ];
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected archive contents: ${files.join(", ")}`);
  }

  const bytes = await Bun.file(tarball).arrayBuffer();
  const sha256 = createHash("sha256")
    .update(new Uint8Array(bytes))
    .digest("hex");
  const filename = `${name}-${version}-${sha256.slice(0, 12)}.tgz`;
  const consumer = join(temp, "consumer");
  await mkdir(join(consumer, "vendor"), { recursive: true });
  await Bun.write(join(consumer, "vendor", filename), bytes);
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { [name]: `file:vendor/${filename}` },
    }),
  );
  await Bun.write(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM"],
        strict: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        types: [],
      },
      include: ["example", "node_modules/eumenes-steer/src"],
    }),
  );
  await cp(join(root, "example"), join(consumer, "example"), {
    recursive: true,
  });
  await cp(join(root, "test"), join(consumer, "test"), { recursive: true });
  run(
    consumer,
    "bun",
    "install",
    "--offline",
    "--ignore-scripts",
    "--cache-dir",
    join(temp, "cache-install"),
  );
  run(consumer, "bun", "check");
  run(consumer, "bun", "test", "./test");

  await rm(join(consumer, "node_modules"), { recursive: true });
  const relocated = join(temp, "relocated");
  await rename(consumer, relocated);
  run(
    relocated,
    "bun",
    "install",
    "--offline",
    "--ignore-scripts",
    "--frozen-lockfile",
    "--cache-dir",
    join(temp, "cache-relocated"),
  );
  run(relocated, "bun", "check");
  run(relocated, "bun", "test", "./test");

  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  await Bun.write(join(dist, filename), bytes);
  console.log(`dist/${filename}\nSHA-256 ${sha256}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
