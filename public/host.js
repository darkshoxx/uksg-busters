/*
 * host.js — read-only question display for the host's own device.
 * Takes no actions; the operator (admin page) judges answers.
 */

function render(state) {
  document.getElementById("team1Name").textContent = state.team1Name;
  document.getElementById("team2Name").textContent = state.team2Name;
  document.getElementById("score1").textContent = state.score1;
  document.getElementById("score2").textContent = state.score2;

  const idle = document.getElementById("idleState");
  const qState = document.getElementById("questionState");

  if (state.phase === "question_open" || state.phase === "buzzed") {
    idle.classList.add("hidden");
    qState.classList.remove("hidden");
    document.getElementById("hostQuestion").textContent = state.question || "";
    document.getElementById("hostTag").textContent =
      state.phase === "buzzed" ? `${state.buzzedTeam === "team1" ? state.team1Name : state.team2Name} is answering` : "Open — waiting for a buzz-in";
    const answerWrap = document.getElementById("hostAnswerWrap");
    if (state.answer) {
      document.getElementById("hostAnswer").textContent = state.answer;
      answerWrap.classList.remove("hidden");
    } else {
      answerWrap.classList.add("hidden");
    }
  } else if (state.phase === "game_over") {
    idle.classList.remove("hidden");
    qState.classList.add("hidden");
    idle.textContent = `${state.winner === "team1" ? state.team1Name : state.team2Name} has won the game!`;
  } else {
    idle.classList.remove("hidden");
    qState.classList.add("hidden");
    idle.textContent = "Waiting for the next hexagon to be opened…";
  }
}

connectSSE("host", render);
