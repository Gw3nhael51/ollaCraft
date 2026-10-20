.PHONY: run logs bot stop issue test
run:
	docker compose up -d
logs:
	docker compose logs -f

bot:
	clear
	node src/index.js

stop:
	docker compose down

issue:
	gh issue list --state open --search "sort:created-asc" -L 1

test:
	node --test test/bot.test.js