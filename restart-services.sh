#!/bin/bash
# Reinicio limpio de worker + dashboard sin auto-matchear la shell.
cd /home/jay/slippi-pipeline
for pat in worker-server dashboard-server; do
  for pid in $(ps -eo pid,args | grep -E "^ *[0-9]+ node ${pat}\.js$" | awk '{print $1}'); do
    echo "kill $pat ($pid)"; kill "$pid" 2>/dev/null
  done
done
sleep 2
setsid node worker-server.js >> worker-server.log 2>&1 < /dev/null &
setsid node dashboard-server.js >> dashboard-server.log 2>&1 < /dev/null &
sleep 4
ps -eo pid,args | grep -E '^ *[0-9]+ node (worker|dashboard)-server\.js$'
curl -s -o /dev/null -w 'dashboard:%{http_code}\n' http://localhost:8081/api/config
tail -2 worker-server.log
