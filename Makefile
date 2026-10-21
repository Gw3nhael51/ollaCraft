.PHONY: run logs bot bot-logs bot-stop stop issue test
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