# GeoVec

A georeferenced vector editor built with React, TypeScript, Vite, and OpenLayers.

## Development

Requires Node.js 20+.

```sh
npm install
npm run dev
```

To type-check and create a production build:

```sh
npm run build
npm run preview
```

## Features

- First-use terms of use and privacy notice. Acceptance is stored in the browser's
  local storage.
- Editable project title in the top bar, saved locally in the browser.
- OpenStreetMap with zoom, panning, and cursor coordinate display.
- Location search with suggestions and map recentering using Photon and
  OpenStreetMap data; supports keyboard navigation with the arrow keys, Enter,
  and Escape.
- Button to center the map on the device's current location; requires granting
  location permission in the browser.
- Point and line drawing. A point can also be placed with the middle mouse
  button without changing tools.
- Selection, moving, vertex editing, and deletion are always available, even
  while Point or Line drawing mode is active. Drawing modes remain active until
  another tool is selected.
- Multi-point selection by right-dragging a selection box or Ctrl + left-click
  to toggle individual points. Selected points can be moved and deleted
  together.
- Delete the selected object with Delete or Backspace; actions can be undone and
  redone. Deleting points also deletes their connected lines.
- Undo and redo with Ctrl+Z and Ctrl+Y (also available in the top bar).
- Lines can only be created between existing points: click a starting point, see
  a live preview, then click a different point to confirm. Duplicate lines
  between the same pair of points are prevented, regardless of endpoint order.
- Lines remain anchored to their endpoints. Moving a point updates all
  connected line endpoints in real time; moving or editing a line also updates
  its endpoint points to preserve the connections. Point and line references
  are preserved when exporting and importing GeoJSON.
- Geodesic line measurement in kilometers after creation and on selection. It
  calculates surface distance along the Earth's sphere (great-circle distance)
  and combines it with the elevation difference between endpoints. The
  measurement updates when editing a line or changing the elevation of a
  connected point.
- Dialog to view and edit a point's latitude, longitude, and optional elevation
  in meters, opened by double-clicking a point. Blank elevation is treated as
  0 m above sea level and is stored in the GeoJSON
  `altitudeMetersAboveSeaLevel` property.
- Color, width, and opacity editing.
- GeoJSON import and export. The app transforms between the view projection
  EPSG:3857 and WGS 84 / EPSG:4326 data coordinates, with up to eight decimal
  places in exported coordinates.

Vector data stays in memory for the duration of the session. Export your
project to keep it; local saving and automatic restoration of vector data are
not yet implemented.

Bezier curves require an editable model that preserves anchors and control
points in addition to the interoperable linear approximation. They will be
added in a future iteration.

The base map uses OpenStreetMap tiles. For production, review its usage policies
and keep the visible attribution.

The editor uses Web Mercator to render the map, so coordinate editing limits
latitude to the valid range of that projection (±85.05112878°).
