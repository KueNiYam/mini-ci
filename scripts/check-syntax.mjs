import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "test"];

for (const file of roots.flatMap((root) => collectTypeScriptFiles(root))) {
  const result = spawnSync(process.execPath, ["--check", "--experimental-strip-types", file], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

/** 지정된 디렉터리 아래의 TypeScript 파일을 재귀적으로 찾습니다. */
function collectTypeScriptFiles(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      const stat = statSync(path);

      if (stat.isDirectory()) {
        return collectTypeScriptFiles(path);
      }

      return path.endsWith(".ts") ? [path] : [];
    })
    .sort();
}
