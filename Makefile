.PHONY: run logs bot
run:
	docker compose up -d
logs:
	docker compose logs -f

bot:
	clear
	node bot.js

stop:
	docker compose down