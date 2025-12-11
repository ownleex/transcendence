export interface Player {
  id: number;
  alias: string;
}

export interface GameState {
  player1Y: number;
  player2Y: number;
  ballX: number;
  ballY: number;
}
