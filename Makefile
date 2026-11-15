.PHONY: run logs bot bot-logs bot-stop stop issue test reset-server
run:
	docker compose up -d
logs:
	docker compose logs -f

bot:
	clear
	docker compose --profile bot up -d --build bot
	docker compose logs -f bot

bot-logs:
	docker compose logs -f bot

bot-stop:
	docker compose --profile bot stop bot

stop:
	docker compose --profile bot down

issue:
	gh issue list --state open --search "sort:created-asc" -L 1

test:
	node --test test/bot.test.js

reset-server:
	ssh ovh "cd minecraft-server && docker compose down && docker run --rm -v minecraft-server_mc-data:/data alpine sh -c 'rm -rf /data/world /data/world_nether /data/world_the_end /data/logs/* /data/plugins/AuthMe/playerdata/* && truncate -s 0 /data/plugins/AuthMe/authme.log && chown -R 1000:1000 /data/logs /data/plugins/AuthMe' && docker compose up -d --force-recreate"
