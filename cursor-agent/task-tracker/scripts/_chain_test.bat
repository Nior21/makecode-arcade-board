@echo off
setlocal enabledelayedexpansion

set SID=97383f7e-4dae-4135-9893-28e592c9f4ae

echo === 1. CREATE ===
curl -s -X POST http://192.168.88.153:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json" -H "Mcp-Session-Id: %SID%" -d "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/call\",\"params\":{\"name\":\"create_task\",\"arguments\":{\"title\":\"Chain test task\",\"description\":\"Testing full lifecycle\",\"priority\":\"critical\",\"project\":\"chain-test\"}}}" > %TEMP%\rpc_create.json
python -c "import json; d=json.load(open(r'%TEMP:\=\\rpc_create.json')); t=json.loads(d['result']['content'][0]['text']); print(f'Created: {t[\"id\"][:8]}... title={t[\"title\"]} score={t[\"priority_score\"]}'); open(r'%TEMP:\=\\_task_id.txt','w').write(t['id'])"

set /p TASK_ID=<%TEMP%\_task_id.txt
echo Task ID: !TASK_ID!

echo === 2. GET ===
curl -s -X POST http://192.168.88.153:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json" -H "Mcp-Session-Id: %SID%" -d "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"id\":\"!TASK_ID!\"}}}" > %TEMP%\rpc_get.json
python -c "import json; d=json.load(open(r'%TEMP:\=\\rpc_get.json')); t=json.loads(d['result']['content'][0]['text']); print(f'Got: {t[\"title\"]} status={t[\"status\"]}')"

echo === 3. UPDATE ===
curl -s -X POST http://192.168.88.153:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json" -H "Mcp-Session-Id: %SID%" -d "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"update_task\",\"arguments\":{\"id\":\"!TASK_ID!\",\"updates\":{\"status\":\"done\"}}}}" > %TEMP%\rpc_update.json
python -c "import json; d=json.load(open(r'%TEMP:\=\\rpc_update.json')); t=json.loads(d['result']['content'][0]['text']); print(f'Updated: status={t[\"status\"]} score={t[\"priority_score\"]}')"

echo === 4. LIST ===
curl -s -X POST http://192.168.88.153:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json" -H "Mcp-Session-Id: %SID%" -d "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"tools/call\",\"params\":{\"name\":\"list_tasks\",\"arguments\":{\"project\":\"chain-test\"}}}" > %TEMP%\rpc_list.json
python -c "import json; d=json.load(open(r'%TEMP:\=\\rpc_list.json')); tasks=json.loads(d['result']['content'][0]['text']); print(f'List: {len(tasks)} tasks'); [print(f'  {t[\"title\"]} ({t[\"status\"]})') for t in tasks]"

echo === 5. SEARCH ===
curl -s -X POST http://192.168.88.153:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json" -H "Mcp-Session-Id: %SID%" -d "{\"jsonrpc\":\"2.0\",\"id\":14,\"method\":\"tools/call\",\"params\":{\"name\":\"search_tasks\",\"arguments\":{\"query\":\"chain\"}}}" > %TEMP%\rpc_search.json
python -c "import json; d=json.load(open(r'%TEMP:\=\\rpc_search.json')); tasks=json.loads(d['result']['content'][0]['text']); print(f'Search: {len(tasks)} found')"

echo === 6. DELETE ===
ssh pi@192.168.88.153 "rm -f /home/pi/task-tracker/tasks/!TASK_ID!.json"
ssh pi@192.168.88.153 "cat > /tmp/cleanup-chain.js << 'SCRIPT'
const {readFileSync,writeFileSync,existsSync}=require('fs');
const f='/home/pi/task-tracker/tasks/index.json';
if(existsSync(f)){
  const i=JSON.parse(readFileSync(f,'utf8'));
  i.tasks=i.tasks.filter(t=>t!=='!TASK_ID!');
  Object.keys(i.projects).forEach(p=>{
    i.projects[p]=i.projects[p].filter(t=>t!=='!TASK_ID!');
    if(!i.projects[p].length) delete i.projects[p];
  });
  writeFileSync(f,JSON.stringify(i,null,2));
}
SCRIPT
node /tmp/cleanup-chain.js"
echo Deleted: !TASK_ID!

del %TEMP%\rpc_*.json %TEMP%\_task_id.txt 2>nul
echo === DONE ===
