# pi-acp-plus

`pi-acp` 0.0.33 (MIT, https://github.com/svkozak/pi-acp) 의 **설치 사본을 복사해 `dist/index.js`를 직접 패치**한 것이다.
소스 저장소·빌드 단계는 없다. 전역 bin `pi-acp-plus`는 이 디렉터리로의 심링크다
(`npm install -g /home/test/pi-acp-plus`). 원본 README는 `README.pi-acp.md`, 라이선스는 `LICENSE`.

## 패치 (dist/index.js)

1. **`session/new.mcpServers` 주입.** 원본은 목록을 `PiAcpSession.mcpServers`에 저장만 하고 쓰지 않는다.
   `piAcpPlusSpawnExtras()`가 stdio 엔트리를 `PI_ACP_PLUS_MCP_SERVERS`(JSON)로 만들고 `pi`를
   `-e ext/acp-mcp.ts`와 함께 띄운다. `PiRpcProcess.spawn`은 `extraArgs`·`extraEnv`를 받도록 확장했고,
   `session/new`(`SessionRegistry.create`)와 `session/load` 복원 경로 둘 다 거친다.
2. **시작 배너를 stderr로.** `sendStartupInfoIfPending()`이 `agent_message_chunk` 대신 stderr에 쓴다.
   `PI_ACP_PLUS_STARTUP_BANNER=1`이면 원본 동작.
3. 식별자: `--terminal-login` 재실행 명령과 상태 디렉터리(`~/.pi/pi-acp-plus`)를 분리했다. `agentInfo.name`은
   package.json 이름을 따른다.

4. **stderr 전달·dispose 에스컬레이션.** 원본은 pi 의 stderr 를 버렸다(`child.stderr.on("data", () => {})`) — 확장의 기동 실패·등록 로그가 어디에도 남지 않았다. 이제 우리 stderr 로 넘긴다(devteam 은 워커 stderr 로그로 받는다). `dispose()`는 SIGTERM 5초 뒤 SIGKILL 로 확정 종료한다.

## 확장 (ext/acp-mcp.ts)

pi가 jiti로 직접 로드하는 순수 JS. 환경변수의 서버마다 `StdioClientTransport`로 붙어 `tools/list`를 받고
(자식 env 는 SDK 화이트리스트 `getDefaultEnvironment()` + ACP 엔트리의 env 만 — 워커 환경 전체를 물려주지 않는다)
`<서버>_<도구>` 이름으로 `pi.registerTool`한다. 요청 timeout은 24h(블록형 도구용), `session_shutdown`에 닫는다.
의존성(`@modelcontextprotocol/sdk`, `typebox`)은 이 디렉터리의 `node_modules`에서 해석된다 — `npm install --omit=dev`.

## 업스트림을 새로 들일 때

```bash
npm install -g pi-acp@<ver>                       # 임시 설치
rm -rf /home/test/pi-acp-plus/dist && cp -r $(npm root -g)/pi-acp/dist /home/test/pi-acp-plus/dist   # dist 교체 (rm 없이 cp 하면 dist/dist 로 중첩된다)
# 위 1~4 패치를 다시 적용. 확인: grep -n 'piAcpPlusSpawnExtras\|PI_ACP_PLUS\|pi-acp-plus\|process.stderr.write(chunk)\|SIGKILL' dist/index.js
#   → spawn 의 extraArgs/extraEnv, piAcpPlusSpawnExtras, create/restore 두 spawn 호출, sendStartupInfoIfPending 의 stderr 분기,
#     터미널 로그인 재실행 명령 "pi-acp-plus", 상태 디렉터리 ~/.pi/pi-acp-plus, fallback agentInfo, stderr 전달, dispose 의 SIGKILL 에스컬레이션
node --check /home/test/pi-acp-plus/dist/index.js
npm uninstall -g pi-acp
```

검증: `initialize` → `session/new`(devteam stdio 엔트리) → `session/prompt`로 `devteam_list_workers`가 호출되는지.
