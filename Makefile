-include .env

export

NAME = ft_transcendence

# Colors
GREEN = \033[0;32m
YELLOW = \033[0;33m
RED = \033[0;31m
BLUE = \033[0;34m
NC = \033[0m # No Color

all:
	@echo "$(BLUE)🚀 Building $(NAME)...$(NC)"
	@docker compose build
	@echo "$(GREEN)✓ Build complete!$(NC)"
	@echo "$(BLUE)🔄 Starting containers...$(NC)"
	@docker compose up -d
	@echo "$(GREEN)✓ $(NAME) is up and running! $(API_BASE) or https://localhost:3000$(NC)"
up: 
	@docker compose up -d

down:
	@docker compose down

stop:
	@docker compose stop

ps:
	@docker compose ps

log:
	@docker compose logs -f

clean:
	@echo "$(YELLOW)🛑 Stopping containers...$(NC)"
	@docker compose down
	@echo "$(GREEN)✓ Containers stopped!$(NC)"


fclean: clean
	@echo "$(RED)🧹 Cleaning Docker system...$(NC)"
	@docker compose down --volumes --remove-orphans
	@docker system prune -af --volumes
	@sudo rm -rf ./backend/data
	@echo "$(GREEN)✓ Data directory removed!$(NC)"
	@echo "$(GREEN)✓ System cleaned!$(NC)"

re: fclean all

.PHONY: all up down stop clean fclean re ps log