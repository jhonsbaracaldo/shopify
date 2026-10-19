n8n import:credentials --input=/wf/cred.json >/dev/null 2>&1
for id in wfImportacionA wfEvaluacionB wfShopifyCcrear; do
  n8n import:workflow --input=/wf/$id.json >/dev/null 2>&1
  n8n execute --id=$id --rawOutput > /tmp/$id.out 2>/tmp/$id.err; echo "EXEC $id EXIT=$?"
  echo "===BEGIN $id==="; cat /tmp/$id.out; echo; echo "===END $id==="
done
