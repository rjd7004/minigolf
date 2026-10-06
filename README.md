# Mini Golf

A simple 2D minigolf game for the browser, in the style of GamePigeon mini golf. Two players, five randomly generated holes per round. Built for phones.

## Two ways to play

**Play a friend (each on your own phone).** Enter your name, take your first shot, then tap **Send link** and text it to your friend. When they open it, they type their name, watch your shot replay, and take theirs. Then they send a link back. Keep trading links until you've both finished all five holes.

The whole game is stored in the link itself (the part after `#`), so there's no server or account. The holes aren't in the link: both phones rebuild the same five holes from a random seed. Each phone remembers the newest turn it has seen, so reopening an old link won't let anyone retake a shot.

**Same phone.** Enter both names and pass the phone back and forth.

## How to play

- Touch anywhere on the course and **drag back** to aim. The dotted arrow shows where the ball will go; pull further for more power (the ring around the ball fills up). Let go to putt. A tiny drag cancels.
- Players alternate shots. Once a player sinks the ball, the other keeps going until they hole out. Whoever won the last hole tees off first on the next one.
- Every round is five new holes that get longer and trickier from hole 1 to hole 5.
- **Yellow bumpers** kick the ball away and add speed. **Slopes** are shaded light (high side) to dark (low side), and the arrows point downhill, the way the ball gets pushed.
- Hit the ball too hard and it lips out of the cup. Water is a one-stroke penalty and puts you back where you shot from. Sand slows the ball down. You pick up at 10 strokes on a hole.
- Lowest total over the five holes wins. **Play again** swaps who tees off first.

## Running it

No build step and no dependencies: it's plain HTML, CSS and JavaScript.

- Open `index.html` in a browser, or
- serve the folder: `python3 -m http.server 8000`, then on a phone on the same Wi-Fi open `http://<your-computer-ip>:8000`.

Links only work for your friend if the game is hosted at a public address. The easiest option is GitHub Pages: in the repo go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save. The game will be at `https://rjd7004.github.io/minigolf/`. The link-preview image in `index.html` points at that address; update the `og:image` URL if you host it somewhere else.

On iOS, "Add to Home Screen" runs it full screen.

## Versions

The version shows in the bottom-right corner. It's set in `index.html`: when releasing, bump the label and every `?v=` link to the stylesheet and scripts (the `?v=` makes phones fetch the new files instead of a cached copy).

- v2.0: five randomly generated holes per round, kicking bumpers, slopes, white walls and obstacles, scorecard
- v1.4: slightly easier drop-ins, especially near the edge of the cup
- v1.3: lower max power, faster early slowdown, smaller and tougher cup, new drop-in animation
- v1.2: version label
- v1.1: smoother roll-out, ball can ride the rim of the cup
- v1.0: first release (same-phone and play-a-friend link modes)

## Files

- `index.html`: page layout (scoreboard, course canvas, menu and results screens)
- `style.css`: mobile-first styling
- `course.js`: the hole generator. Each hole is a path of cells on a 5×8 grid from the tee to the cup, widened in places, with walls wherever a cell borders the rough. Every fairway cell joins that one path, so there are no walled-off islands. After obstacles are added, the hole is flood-filled at ball size and thrown away if the cup or any open area can't be reached. Difficulty per hole is set in the `LEVELS` table.
- `game.js`: physics, input, rendering, turn and hole flow, and the link encoding
- `preview.png`, `icon.png`: link preview image and home-screen icon
