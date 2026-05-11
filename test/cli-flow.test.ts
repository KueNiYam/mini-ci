import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProjects,
  getRecentJobsForProjectName,
  isTriggerTokenConfigured,
  runProjectByName,
  setTriggerToken,
  verifyTriggerToken,
} from "../src/app.ts";
import { initializeDatabase, insertJob, saveProject } from "../src/adapters/database/sqlite.ts";
import type { Job, Project } from "../src/domains/ci/models.ts";

test("directory project에서 CI job을 실행한다", async () => {
  // Given:
  // When:
  // Then:
  const root = await mkdtemp(join(tmpdir(), "mini-ci-dir-"));
  const home = join(root, "home");
  const projectPath = join(root, "app");
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, "README.md"), "hello\n");

  initializeDatabase(home);
  saveProject(home, createProject("project-a", "app", projectPath));

  const job = runProjectByName(home, { name: "app", ref: "manual-test" });

  const resultPath = join(projectPath, "ci-result.txt");
  assert.equal(job.status, "success");
  assert.equal(existsSync(resultPath), true);
  assert.equal(readFileSync(resultPath, "utf8"), "ok");
});

test("여러 프로젝트의 job을 프로젝트별로 조회한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-projects-"));
  const home = join(root, "home");
  const projectA = createProject("project-a", "app-a", join(root, "app-a"));
  const projectB = createProject("project-b", "app-b", join(root, "app-b"));

  initializeDatabase(home);
  saveProject(home, projectA);
  saveProject(home, projectB);
  insertJob(home, createJob("job-a", projectA.id, "ref-a", join(root, "a.log")));
  insertJob(home, createJob("job-b", projectB.id, "ref-b", join(root, "b.log")));

  assert.deepEqual(
    getProjects(home).map((project) => project.name),
    ["app-a", "app-b"],
  );
  assert.deepEqual(
    getRecentJobsForProjectName(home, projectA.name).map((job) => job.ref),
    ["ref-a"],
  );
  assert.deepEqual(
    getRecentJobsForProjectName(home, projectB.name).map((job) => job.ref),
    ["ref-b"],
  );
});

test("trigger token은 hash로 저장되고 원문 검증만 허용한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-ci-http-"));
  const home = join(root, "home");
  initializeDatabase(home);

  assert.equal(isTriggerTokenConfigured(home), false);

  const token = setTriggerToken(home, "plain-token");

  assert.equal(token, "plain-token");
  assert.equal(isTriggerTokenConfigured(home), true);
  assert.equal(verifyTriggerToken(home, "wrong-token"), false);
  assert.equal(verifyTriggerToken(home, "plain-token"), true);
});

/** 테스트용 프로젝트 모델을 만듭니다. */
function createProject(id: string, name: string, projectPath: string): Project {
  return {
    id,
    name,
    projectPath,
    commands: ["printf ok > ci-result.txt"],
    createdAt: `2026-05-11T00:00:0${id.endsWith("a") ? "1" : "2"}.000Z`,
  };
}

/** 테스트용 job 모델을 만듭니다. */
function createJob(id: string, projectId: string, ref: string, logPath: string): Job {
  return {
    id,
    projectId,
    ref,
    status: "success",
    failedStep: null,
    exitCode: 0,
    logPath,
    createdAt: id.endsWith("a") ? "2026-05-11T00:00:01.000Z" : "2026-05-11T00:00:02.000Z",
    startedAt: null,
    finishedAt: null,
  };
}
