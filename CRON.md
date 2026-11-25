# Keeping SmartHub running

Frontend (port 8080) and backend (port 8000) each run under a small supervisor that restarts them if they crash. Cron starts them after a reboot and checks them every 5 minutes. No sudo needed.

## Cron

`crontab -l` should show:

```
@reboot     /home/sa-prd-rdi-react-dev/Smarthub/frontend/scripts/frontend.sh start
*/5 * * * * /home/sa-prd-rdi-react-dev/Smarthub/frontend/scripts/frontend.sh ensure
@reboot     /home/sa-prd-rdi-react-dev/Smarthub/backend/scripts/backend.sh start
*/5 * * * * /home/sa-prd-rdi-react-dev/Smarthub/backend/scripts/backend.sh ensure
```

- `@reboot ... start` starts it when the server boots.
- `*/5 ... ensure` runs every 5 minutes. Healthy: does nothing. Down: starts it. Not answering: restarts it.

To edit: `crontab -e`, press `i`, make the change, `Esc`, `:wq`.

## Commands

Run from `Smarthub/`:

| What | Frontend | Backend |
|---|---|---|
| Is it up? | `frontend/scripts/frontend.sh status` | `backend/scripts/backend.sh status` |
| Start | `frontend/scripts/frontend.sh start` | `backend/scripts/backend.sh start` |
| Stop | `frontend/scripts/frontend.sh stop` | `backend/scripts/backend.sh stop` |
| Restart | `frontend/scripts/frontend.sh restart` | `backend/scripts/backend.sh restart` |

## Logs

| | Frontend | Backend |
|---|---|---|
| App log | `frontend/logs/frontend.log` | `backend/logs/backend.log` |
| Starts made by cron | `frontend/logs/frontend.out` | `backend/logs/backend.out` |

Logs rotate at 50 MB, 5 files kept.

## Releases

- Frontend: `cd frontend && npm run build`. Picked up right away, no restart.
- Backend: `git pull`, then `backend/scripts/backend.sh restart`.
- New SSL certificate: replace the two `.pem` files in `SSL2026/`, then `frontend/scripts/frontend.sh reload` (no downtime) and `backend/scripts/backend.sh restart`.

## Settings

`frontend/.env.server` and `backend/.env.server` hold the port, node/python path and certificate paths. Copy from the `.env.server.example` next to each. They are not in git.

## If something is wrong

- `status` says Stopped: run `start`. If it fails, it prints the last log lines.
- Scripts say "Permission denied": `chmod 755 frontend/scripts/frontend.sh backend/scripts/backend.sh backend/scripts/supervise.py`
- Backend log says "giving up": it crashed 5 times in 5 minutes. Fix the error in `backend/logs/backend.log`, then `start`.
- Port already in use: an old process is still running. Find it with `ss -ltnp | grep 8080` (or 8000) and stop it.
