.PHONY: run logs bot
run:
	docker compose up -d
logs:
	docker compose logs -f

bot:
	clear
	node src/index.js

stop:
	docker compose down