import { useCallback, useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { Draw, Modify, Select, Translate } from "ol/interaction";
import { click } from "ol/events/condition";
import { GeoJSON } from "ol/format";
import { fromLonLat, toLonLat } from "ol/proj";
import { getDistance } from "ol/sphere";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import type { Geometry } from "ol/geom";
import type { Coordinate } from "ol/coordinate";
import type { FeatureLike } from "ol/Feature";

type Tool = "auto" | "Point" | "LineString";
type VectorProperties = {
  color: string;
  width: number;
  opacity: number;
};
type HistoryState = {
  past: string[];
  future: string[];
};
type LocationResult = {
  id: string;
  label: string;
  detail: string;
  longitude: number;
  latitude: number;
};

type PhotonFeature = {
  geometry?: { coordinates?: unknown };
  properties?: {
    name?: unknown;
    street?: unknown;
    housenumber?: unknown;
    postcode?: unknown;
    district?: unknown;
    city?: unknown;
    state?: unknown;
    country?: unknown;
  };
};

const DEFAULT_STYLE: VectorProperties = {
  color: "#25d0ab",
  width: 3,
  opacity: 0.9,
};
const MAX_MERCATOR_LATITUDE = 85.05112878;
const ALTITUDE_PROPERTY = "altitudeMetersAboveSeaLevel";
const POINT_ID_PROPERTY = "geovecPointId";
const LINE_START_POINT_ID_PROPERTY = "geovecStartPointId";
const LINE_END_POINT_ID_PROPERTY = "geovecEndPointId";
const TERMS_STORAGE_KEY = "geovec-terms-privacy-accepted";
const TERMS_VERSION = "1";
const PROJECT_TITLE_STORAGE_KEY = "geovec-project-title";
const DEFAULT_PROJECT_TITLE = "Untitled project";
const LEGACY_DEFAULT_PROJECT_TITLE = "Proyecto sin título";
const EMPTY_FEATURE_COLLECTION = '{"type":"FeatureCollection","features":[]}';
const GEOJSON_FORMAT = new GeoJSON();
const featureStyleCache = new WeakMap<FeatureLike, { key: string; style: Style }>();

function getPointId(feature: Feature<Geometry>) {
  const id = feature.get(POINT_ID_PROPERTY);
  return typeof id === "string" && id.length > 0 ? id : null;
}

function createPointId() {
  return crypto.randomUUID();
}

function serializeFeatures(features: Feature<Geometry>[]) {
  return GEOJSON_FORMAT.writeFeatures(features, {
    featureProjection: "EPSG:3857",
    dataProjection: "EPSG:4326",
    decimals: 12,
  });
}

function featureStyle(feature: FeatureLike) {
  const color = String(feature.get("color") ?? DEFAULT_STYLE.color);
  const width = Number(feature.get("width") ?? DEFAULT_STYLE.width);
  const opacity = Number(feature.get("opacity") ?? DEFAULT_STYLE.opacity);
  const key = `${color}\u0000${width}\u0000${opacity}`;
  const cached = featureStyleCache.get(feature);
  if (cached?.key === key) return cached.style;

  const style = new Style({
    image: new CircleStyle({
      radius: 7,
      fill: new Fill({ color: `rgba(37, 208, 171, ${opacity})` }),
      stroke: new Stroke({ color: "#101820", width: 2 }),
    }),
    fill: new Fill({ color: `rgba(37, 208, 171, ${opacity * 0.18})` }),
    stroke: new Stroke({ color, width, lineCap: "round", lineJoin: "round" }),
  });
  featureStyleCache.set(feature, { key, style });
  return style;
}

function selectedStyle() {
  return new Style({
    image: new CircleStyle({
      radius: 8,
      fill: new Fill({ color: "#fff" }),
      stroke: new Stroke({ color: "#f2a65a", width: 3 }),
    }),
    fill: new Fill({ color: "rgba(242, 166, 90, 0.16)" }),
    stroke: new Stroke({ color: "#f2a65a", width: 3, lineDash: [8, 5] }),
  });
}

function previewLineStyle() {
  return new Style({
    stroke: new Stroke({
      color: "#087f69",
      width: 3,
      lineDash: [8, 6],
      lineCap: "round",
    }),
  });
}

function getGeometryLabel(feature: Feature<Geometry> | null) {
  if (!feature) return "No object selected";
  const type = feature.getGeometry()?.getType();
  if (type === "Point") return "Point";
  if (type === "LineString") return "Line";
  if (type === "Polygon") return "Polygon";
  return "Vector";
}

function getLineLengthKm(
  feature: Feature<Geometry> | null,
  features: Feature<Geometry>[] = [],
) {
  if (!feature) return null;
  const geometry = feature.getGeometry();
  if (!(geometry instanceof LineString)) return null;
  const coordinates = geometry.getCoordinates();
  const altitudeAt = (coordinate: Coordinate, pointId: unknown) => {
    const matchedPoint = features.find((candidate) => {
      const point = candidate.getGeometry();
      if (!(point instanceof Point)) return false;
      if (typeof pointId === "string" && getPointId(candidate) === pointId) return true;
      const pointCoordinate = point.getCoordinates();
      return (
        Math.abs(pointCoordinate[0] - coordinate[0]) < 0.01 &&
        Math.abs(pointCoordinate[1] - coordinate[1]) < 0.01
      );
    });
    if (!matchedPoint) return coordinate[2] ?? 0;
    const pointGeometry = matchedPoint.getGeometry();
    const altitudeProperty = matchedPoint.get(ALTITUDE_PROPERTY);
    if (typeof altitudeProperty === "number" && Number.isFinite(altitudeProperty)) {
      return altitudeProperty;
    }
    return pointGeometry instanceof Point ? pointGeometry.getCoordinates()[2] ?? 0 : coordinate[2] ?? 0;
  };
  let distanceMeters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const horizontalDistance = getDistance(toLonLat(start), toLonLat(end));
    const startAltitude = altitudeAt(
      start,
      index === 1 ? feature.get(LINE_START_POINT_ID_PROPERTY) : null,
    );
    const endAltitude = altitudeAt(
      end,
      index === coordinates.length - 1 ? feature.get(LINE_END_POINT_ID_PROPERTY) : null,
    );
    distanceMeters += Math.hypot(horizontalDistance, endAltitude - startAltitude);
  }
  return distanceMeters / 1000;
}

function formatDistanceKm(distance: number) {
  return `${new Intl.NumberFormat("en", {
    maximumFractionDigits: distance < 10 ? 3 : 2,
  }).format(distance)} km`;
}

export default function App() {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const sourceRef = useRef<VectorSource | null>(null);
  const previewSourceRef = useRef<VectorSource | null>(null);
  const previewFeatureRef = useRef<Feature<Geometry> | null>(null);
  const selectRef = useRef<Select | null>(null);
  const modifyRef = useRef<Modify | null>(null);
  const translateRef = useRef<Translate | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectTitleInputRef = useRef<HTMLInputElement>(null);
  const coordinatesElementRef = useRef<HTMLSpanElement>(null);
  const lineDistanceElementRef = useRef<HTMLElement>(null);
  const cancelProjectTitleBlurRef = useRef(false);
  const activeToolRef = useRef<Tool>("auto");
  const lineStartRef = useRef<Feature<Geometry> | null>(null);
  const styleRef = useRef<VectorProperties>(DEFAULT_STYLE);
  const historyRef = useRef<HistoryState>({
    past: [EMPTY_FEATURE_COLLECTION],
    future: [],
  });
  const interactionStartRef = useRef<string | null>(null);
  const skipModifiedClickRef = useRef(false);
  const modifierKeysRef = useRef({ ctrl: false, meta: false });
  const restoringHistoryRef = useRef(false);

  const [tool, setTool] = useState<Tool>("auto");
  activeToolRef.current = tool;
  const [selected, setSelected] = useState<Feature<Geometry> | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [featureCount, setFeatureCount] = useState(0);
  const [message, setMessage] = useState("Select a vector or create a new one.");
  const [style, setStyle] = useState<VectorProperties>(DEFAULT_STYLE);
  const [coordinateDialogOpen, setCoordinateDialogOpen] = useState(false);
  const [latitudeInput, setLatitudeInput] = useState("");
  const [longitudeInput, setLongitudeInput] = useState("");
  const [altitudeInput, setAltitudeInput] = useState("");
  const [coordinateError, setCoordinateError] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [lineDistanceKm, setLineDistanceKm] = useState<number | null>(null);
  const [projectTitle, setProjectTitle] = useState(() => {
    try {
      const storedTitle = window.localStorage.getItem(PROJECT_TITLE_STORAGE_KEY);
      if (storedTitle === LEGACY_DEFAULT_PROJECT_TITLE) {
        try {
          window.localStorage.setItem(PROJECT_TITLE_STORAGE_KEY, DEFAULT_PROJECT_TITLE);
        } catch (error) {
          console.error("Could not migrate the default project title.", error);
        }
        return DEFAULT_PROJECT_TITLE;
      }
      return storedTitle || DEFAULT_PROJECT_TITLE;
    } catch (error) {
      console.error("Could not read the project title.", error);
      return DEFAULT_PROJECT_TITLE;
    }
  });
  const [projectTitleDraft, setProjectTitleDraft] = useState("");
  const [editingProjectTitle, setEditingProjectTitle] = useState(false);
  const [locationQuery, setLocationQuery] = useState("");
  const [locationResults, setLocationResults] = useState<LocationResult[]>([]);
  const [locationSearchOpen, setLocationSearchOpen] = useState(false);
  const [locationSearchLoading, setLocationSearchLoading] = useState(false);
  const [locationSearchError, setLocationSearchError] = useState("");
  const [activeLocationIndex, setActiveLocationIndex] = useState(-1);
  const [locatingUser, setLocatingUser] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(() => {
    try {
      return window.localStorage.getItem(TERMS_STORAGE_KEY) === TERMS_VERSION;
    } catch (error) {
      console.error("Could not read the terms and privacy acceptance.", error);
      return false;
    }
  });
  const [termsStorageError, setTermsStorageError] = useState("");
  styleRef.current = style;

  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < 2 || !locationSearchOpen) {
      setLocationResults([]);
      setLocationSearchLoading(false);
      setLocationSearchError("");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLocationSearchLoading(true);
      setLocationSearchError("");
      try {
        const url = new URL("https://photon.komoot.io/api/");
        url.searchParams.set("q", query);
        url.searchParams.set("limit", "6");
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`The search service responded with status ${response.status}.`);
        }
        const data = await response.json() as { features?: PhotonFeature[] };
        const results = (Array.isArray(data.features) ? data.features : [])
          .flatMap((feature, index): LocationResult[] => {
            const coordinates = feature.geometry?.coordinates;
            const properties = feature.properties;
            if (
              !Array.isArray(coordinates) ||
              typeof coordinates[0] !== "number" ||
              typeof coordinates[1] !== "number" ||
              !Number.isFinite(coordinates[0]) ||
              !Number.isFinite(coordinates[1]) ||
              typeof properties?.name !== "string" ||
              properties.name.length === 0
            ) return [];
            const label = properties.name;
            const detail = [
              properties.street && properties.housenumber
                ? `${properties.street} ${properties.housenumber}`
                : properties.street,
              properties.postcode,
              properties.district,
              properties.city,
              properties.state,
              properties.country,
            ]
              .filter((part): part is string => typeof part === "string" && part.length > 0)
              .filter((part, partIndex, parts) => parts.indexOf(part) === partIndex)
              .filter((part) => part !== label)
              .join(", ");
            return [{
              id: `${label}-${coordinates[0]}-${coordinates[1]}-${index}`,
              label,
              detail,
              longitude: coordinates[0],
              latitude: coordinates[1],
            }];
          });
        setLocationResults(results);
        setActiveLocationIndex(-1);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Could not search for locations.", error);
        setLocationResults([]);
        setLocationSearchError("Could not load results. Please try again.");
      } finally {
        if (!controller.signal.aborted) setLocationSearchLoading(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [locationQuery, locationSearchOpen]);

  const goToLocation = useCallback((location: LocationResult) => {
    mapRef.current?.getView().animate({
      center: fromLonLat([location.longitude, location.latitude]),
      zoom: 14,
      duration: 650,
    });
    setLocationQuery(location.label);
    setLocationSearchOpen(false);
    setLocationResults([]);
    setLocationSearchError("");
  }, []);

  const updateHistoryAvailability = () => {
    setCanUndo(historyRef.current.past.length > 1);
    setCanRedo(historyRef.current.future.length > 0);
  };

  const commitHistory = (snapshot?: string) => {
    if (restoringHistoryRef.current) return;
    const source = sourceRef.current;
    if (!source) return;
    const nextSnapshot = snapshot ?? serializeFeatures(source.getFeatures());
    const history = historyRef.current;
    if (history.past[history.past.length - 1] === nextSnapshot) return;
    history.past.push(nextSnapshot);
    if (history.past.length > 100) history.past.shift();
    history.future = [];
    updateHistoryAvailability();
  };

  const restoreHistorySnapshot = (snapshot: string) => {
    const source = sourceRef.current;
    if (!source) return;
    restoringHistoryRef.current = true;
    selectRef.current?.clearSelection();
    lineStartRef.current = null;
    previewSourceRef.current?.clear(true);
    previewFeatureRef.current = null;
    source.clear(true);
    const features = GEOJSON_FORMAT.readFeatures(snapshot, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    source.addFeatures(features);
    setFeatureCount(features.length);
    setLineDistanceKm(null);
    setSelected(null);
    setSelectedCount(0);
    setCoordinateDialogOpen(false);
    setMessage("The document state was restored.");
    restoringHistoryRef.current = false;
  };

  const undo = useCallback(() => {
    const history = historyRef.current;
    if (history.past.length <= 1) return;
    const current = history.past.pop();
    if (current) history.future.unshift(current);
    const previous = history.past[history.past.length - 1];
    if (previous) restoreHistorySnapshot(previous);
    updateHistoryAvailability();
  }, []);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.shift();
    if (!next) return;
    history.past.push(next);
    restoreHistorySnapshot(next);
    updateHistoryAvailability();
  }, []);

  const openCoordinateEditor = (feature: Feature<Geometry>) => {
    const geometry = feature.getGeometry();
    if (!(geometry instanceof Point)) return;
    const pointCoordinates = geometry.getCoordinates();
    const [longitude, latitude] = toLonLat(pointCoordinates);
    const altitudeProperty = feature.get(ALTITUDE_PROPERTY);
    setSelected(feature);
    setLatitudeInput(latitude.toFixed(8));
    setLongitudeInput(longitude.toFixed(8));
    setAltitudeInput(
      pointCoordinates[2] !== undefined
        ? String(pointCoordinates[2])
        : typeof altitudeProperty === "number" ? String(altitudeProperty) : "",
    );
    setCoordinateError("");
    setCoordinateDialogOpen(true);
  };

  useEffect(() => {
    if (!mapElement.current) return;

    const source = new VectorSource();
    const previewSource = new VectorSource();
    const vectorLayer = new VectorLayer({ source, style: featureStyle });
    const previewLayer = new VectorLayer({ source: previewSource, style: previewLineStyle });
    const selection = new Select({
      condition: (event) => {
        if (!click(event)) return false;
        if (
          skipModifiedClickRef.current ||
          event.originalEvent.ctrlKey ||
          event.originalEvent.metaKey
        ) {
          skipModifiedClickRef.current = false;
          return false;
        }
        return "button" in event.originalEvent && event.originalEvent.button === 0;
      },
      layers: [vectorLayer],
      hitTolerance: 12,
      style: selectedStyle,
    });
    const modify = new Modify({ features: selection.getFeatures() });
    const translate = new Translate({
      features: selection.getFeatures(),
      hitTolerance: 12,
    });
    const map = new Map({
      target: mapElement.current,
      layers: [new TileLayer({ source: new OSM() }), vectorLayer, previewLayer],
      view: new View({
        center: fromLonLat([0, 0]),
        zoom: 0.8,
        minZoom: 0,
        maxZoom: 19,
      }),
      controls: [],
      interactions: undefined,
    });

    map.addInteraction(selection);
    map.addInteraction(modify);
    map.addInteraction(translate);
    const finishInteractionHistory = () => {
      const before = interactionStartRef.current;
      interactionStartRef.current = null;
      if (!before) return;
      const after = serializeFeatures(source.getFeatures());
      if (before !== after) commitHistory(after);
    };
    modify.on("modifystart", () => {
      interactionStartRef.current = serializeFeatures(source.getFeatures());
    });
    modify.on("modifyend", finishInteractionHistory);
    translate.on("translatestart", () => {
      interactionStartRef.current = serializeFeatures(source.getFeatures());
    });
    translate.on("translateend", finishInteractionHistory);
    modify.on("modifyend", (event) => {
      const feature = event.features.item(0) as Feature<Geometry> | undefined;
      setLineDistanceKm(getLineLengthKm(feature ?? null, source.getFeatures()));
    });
    translate.on("translateend", (event) => {
      const feature = event.features.item(0) as Feature<Geometry> | undefined;
      setLineDistanceKm(getLineLengthKm(feature ?? null, source.getFeatures()));
    });
    selection.on("select", () => {
      const selectedFeatures = selection.getFeatures();
      const feature = selectedFeatures.item(selectedFeatures.getLength() - 1) as
        | Feature<Geometry>
        | undefined;
      setSelected(feature ?? null);
      setSelectedCount(selectedFeatures.getLength());
      setLineDistanceKm(
        selectedFeatures.getLength() === 1
          ? getLineLengthKm(feature ?? null, source.getFeatures())
          : null,
      );
      if (feature) {
        setStyle({
          color: String(feature.get("color") ?? DEFAULT_STYLE.color),
          width: Number(feature.get("width") ?? DEFAULT_STYLE.width),
          opacity: Number(feature.get("opacity") ?? DEFAULT_STYLE.opacity),
        });
        setMessage(
          selectedFeatures.getLength() > 1
            ? `${selectedFeatures.getLength()} points selected.`
            : `${getGeometryLabel(feature)} selected.`,
        );
      } else {
        setMessage("No object selected.");
      }
    });
    const togglePointSelectionAtPixel = (pixel: number[]) => {
      const point = map.forEachFeatureAtPixel(
        pixel,
        (candidate) => {
          const feature = candidate as Feature<Geometry>;
          return feature.getGeometry() instanceof Point ? feature : undefined;
        },
        { layerFilter: (layer) => layer === vectorLayer, hitTolerance: 12 },
      );
      if (point) {
        selection.toggleFeature(point);
      }
    };
    const mapViewport = map.getViewport();
    let rightDragStart: [number, number] | null = null;
    let selectionBoxElement: HTMLDivElement | null = null;
    const preventMiddleClickDefault = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    const addPointAtMiddleClick = (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      const feature = new Feature(new Point(map.getCoordinateFromPixel(map.getEventPixel(event))));
      feature.setProperties({
        ...styleRef.current,
        [POINT_ID_PROPERTY]: createPointId(),
      });
      source.addFeature(feature);
      commitHistory();
      selection.clearSelection();
      selection.selectFeature(feature);
      setSelected(feature);
      setSelectedCount(1);
      setMessage("Point added with the middle mouse button.");
    };
    const handleMapPointerDown = (event: PointerEvent) => {
      skipModifiedClickRef.current =
        event.button === 2 ||
        (event.button === 0 &&
          (event.ctrlKey ||
            event.metaKey ||
            modifierKeysRef.current.ctrl ||
            modifierKeysRef.current.meta));
      if (event.button !== 2) return;

      rightDragStart = [event.clientX, event.clientY];
      selectionBoxElement = document.createElement("div");
      selectionBoxElement.className = "map-selection-box";
      selectionBoxElement.style.left = `${event.clientX}px`;
      selectionBoxElement.style.top = `${event.clientY}px`;
      document.body.append(selectionBoxElement);
      event.preventDefault();
    };
    const handleMapPointerMove = (event: PointerEvent) => {
      if (!rightDragStart || !selectionBoxElement) return;
      const left = Math.min(rightDragStart[0], event.clientX);
      const top = Math.min(rightDragStart[1], event.clientY);
      selectionBoxElement.style.left = `${left}px`;
      selectionBoxElement.style.top = `${top}px`;
      selectionBoxElement.style.width = `${Math.abs(event.clientX - rightDragStart[0])}px`;
      selectionBoxElement.style.height = `${Math.abs(event.clientY - rightDragStart[1])}px`;
    };
    const handleMapPointerUp = (event: PointerEvent) => {
      if (
        event.button === 0 &&
        (event.ctrlKey ||
          event.metaKey ||
          modifierKeysRef.current.ctrl ||
          modifierKeysRef.current.meta)
      ) {
        togglePointSelectionAtPixel(map.getEventPixel(event));
      }
      if (event.button === 2 && rightDragStart) {
        const deltaX = event.clientX - rightDragStart[0];
        const deltaY = event.clientY - rightDragStart[1];
        if (Math.hypot(deltaX, deltaY) >= 5) {
          const viewportBounds = mapViewport?.getBoundingClientRect();
          if (viewportBounds) {
            const startPixel: [number, number] = [
              rightDragStart[0] - viewportBounds.left,
              rightDragStart[1] - viewportBounds.top,
            ];
            const endPixel: [number, number] = [
              event.clientX - viewportBounds.left,
              event.clientY - viewportBounds.top,
            ];
            const minX = Math.min(startPixel[0], endPixel[0]);
            const maxX = Math.max(startPixel[0], endPixel[0]);
            const minY = Math.min(startPixel[1], endPixel[1]);
            const maxY = Math.max(startPixel[1], endPixel[1]);
            const pointsInBox = source.getFeatures().filter((feature) => {
              const geometry = feature.getGeometry();
              if (!(geometry instanceof Point)) return false;
              const [x, y] = map.getPixelFromCoordinate(geometry.getCoordinates());
              return x >= minX && x <= maxX && y >= minY && y <= maxY;
            });

            selection.clearSelection();
            for (const point of pointsInBox) selection.selectFeature(point);
            setMessage(
              pointsInBox.length > 0
                ? `${pointsInBox.length} ${pointsInBox.length === 1 ? "point selected" : "points selected"}. Drag to move them together.`
                : "There are no points inside the selection box.",
            );
          }
        }
      }
      rightDragStart = null;
      selectionBoxElement?.remove();
      selectionBoxElement = null;
      skipModifiedClickRef.current = false;
    };
    const preventMapContextMenu = (event: MouseEvent) => event.preventDefault();
    mapViewport?.addEventListener("pointerdown", handleMapPointerDown);
    mapViewport?.addEventListener("mousedown", preventMiddleClickDefault);
    mapViewport?.addEventListener("auxclick", addPointAtMiddleClick);
    window.addEventListener("pointermove", handleMapPointerMove);
    window.addEventListener("pointerup", handleMapPointerUp);
    mapViewport?.addEventListener("contextmenu", preventMapContextMenu);
    map.on("dblclick", (event) => {
      event.preventDefault();
      if (
        event.originalEvent.ctrlKey ||
        event.originalEvent.metaKey
      ) return;
      const feature = map.forEachFeatureAtPixel(
        event.pixel,
        (candidate) => candidate as Feature<Geometry>,
        { layerFilter: (layer) => layer === vectorLayer, hitTolerance: 10 },
      );
      if (feature?.getGeometry() instanceof Point) {
        selection.clearSelection();
        selection.selectFeature(feature);
        setSelectedCount(1);
        openCoordinateEditor(feature);
      }
    });
    map.on("singleclick", (event) => {
      if (
        !("button" in event.originalEvent) ||
        event.originalEvent.button !== 0
      ) return;
      const point = map.forEachFeatureAtPixel(
        event.pixel,
        (candidate) => {
          const feature = candidate as Feature<Geometry>;
          return feature.getGeometry() instanceof Point ? feature : undefined;
        },
        { layerFilter: (layer) => layer === vectorLayer, hitTolerance: 15 },
      );
      if (activeToolRef.current === "Point") {
        const feature = point ?? map.forEachFeatureAtPixel(
          event.pixel,
          (candidate) => candidate as Feature<Geometry>,
          { layerFilter: (layer) => layer === vectorLayer, hitTolerance: 15 },
        );
        if (feature) {
          selection.clearSelection();
          selection.selectFeature(feature);
        }
        return;
      }
      if (activeToolRef.current !== "LineString") return;
      if (!point) {
        const feature = map.forEachFeatureAtPixel(
          event.pixel,
          (candidate) => candidate as Feature<Geometry>,
          { layerFilter: (layer) => layer === vectorLayer, hitTolerance: 15 },
        );
        if (feature) {
          selection.clearSelection();
          selection.selectFeature(feature);
          return;
        }
        setMessage("To draw a line, click an existing point.");
        return;
      }

      const start = lineStartRef.current;
      if (!start) {
        lineStartRef.current = point;
        const startGeometry = point.getGeometry();
        if (!(startGeometry instanceof Point)) return;
        const previewFeature = new Feature(
          new LineString([startGeometry.getCoordinates(), startGeometry.getCoordinates()]),
        );
        previewSource.addFeature(previewFeature);
        previewFeatureRef.current = previewFeature;
        setSelected(point);
        selection.clearSelection();
        selection.getFeatures().push(point);
        setSelectedCount(1);
        setStyle({
          color: String(point.get("color") ?? DEFAULT_STYLE.color),
          width: Number(point.get("width") ?? DEFAULT_STYLE.width),
          opacity: Number(point.get("opacity") ?? DEFAULT_STYLE.opacity),
        });
        setMessage("Start point selected. Click another point once to confirm the line.");
        return;
      }
      if (start === point) {
        setMessage("Choose a different point as the line's endpoint.");
        return;
      }

      const startGeometry = start.getGeometry();
      const endGeometry = point.getGeometry();
      if (!(startGeometry instanceof Point) || !(endGeometry instanceof Point)) return;
      const startPointId = getPointId(start) ?? createPointId();
      const endPointId = getPointId(point) ?? createPointId();
      const connectionAlreadyExists = source.getFeatures().some((candidate) => {
        if (!(candidate.getGeometry() instanceof LineString)) return false;
        const existingStartId = candidate.get(LINE_START_POINT_ID_PROPERTY);
        const existingEndId = candidate.get(LINE_END_POINT_ID_PROPERTY);
        return (
          (existingStartId === startPointId && existingEndId === endPointId) ||
          (existingStartId === endPointId && existingEndId === startPointId)
        );
      });
      if (connectionAlreadyExists) {
        setMessage("A line already connects these two points. Choose another endpoint.");
        return;
      }
      start.set(POINT_ID_PROPERTY, startPointId);
      point.set(POINT_ID_PROPERTY, endPointId);
      const feature = new Feature(
        new LineString([startGeometry.getCoordinates(), endGeometry.getCoordinates()]),
      );
      previewSource.clear(true);
      previewFeatureRef.current = null;
      feature.setProperties({
        ...styleRef.current,
        [LINE_START_POINT_ID_PROPERTY]: startPointId,
        [LINE_END_POINT_ID_PROPERTY]: endPointId,
      });
      source.addFeature(feature);
      commitHistory();
      lineStartRef.current = null;
      setSelected(feature);
      selection.clearSelection();
      selection.getFeatures().push(feature);
      setSelectedCount(1);
      const distance = getLineLengthKm(feature, source.getFeatures());
      setLineDistanceKm(distance);
      setMessage(`Line created between points: ${distance === null ? "" : formatDistanceKm(distance)}.`);
    });
    source.on("addfeature", () => {
      setFeatureCount(source.getFeatures().length);
    });
    source.on("removefeature", () => {
      setFeatureCount(source.getFeatures().length);
    });
    source.on("changefeature", (event) => {
      const changedFeature = event.feature as Feature<Geometry> | undefined;
      const geometry = changedFeature?.getGeometry();
      if (!changedFeature || !geometry) return;

      const lineFeatures = source.getFeatures().filter((feature) => (
        feature.getGeometry() instanceof LineString
      ));
      const coordinatesMatch = (first: Coordinate, second: Coordinate) =>
        first.length === second.length &&
        first.every((value, index) => value === second[index]);

      if (geometry instanceof LineString) {
        const lineCoordinates = geometry.getCoordinates();
        if (lineCoordinates.length < 2) return;
        const endpoints = [
          [changedFeature.get(LINE_START_POINT_ID_PROPERTY), lineCoordinates[0]],
          [changedFeature.get(LINE_END_POINT_ID_PROPERTY), lineCoordinates[lineCoordinates.length - 1]],
        ] as const;
        for (const [pointId, endpoint] of endpoints) {
          if (typeof pointId !== "string") continue;
          const linkedPoint = source.getFeatures().find((feature) => (
            feature.getGeometry() instanceof Point && getPointId(feature) === pointId
          ));
          const pointGeometry = linkedPoint?.getGeometry();
          if (pointGeometry instanceof Point &&
            !coordinatesMatch(pointGeometry.getCoordinates(), endpoint)) {
            pointGeometry.setCoordinates(endpoint);
          }
        }
        setLineDistanceKm(getLineLengthKm(changedFeature, source.getFeatures()));
      } else if (geometry instanceof Point) {
        const pointId = getPointId(changedFeature);
        if (!pointId) return;
        const pointCoordinates = geometry.getCoordinates();
        for (const feature of lineFeatures) {
          const line = feature.getGeometry();
          if (!(line instanceof LineString)) continue;

          const lineCoordinates = line.getCoordinates();
          if (lineCoordinates.length < 2) continue;
          const startPointId = feature.get(LINE_START_POINT_ID_PROPERTY);
          const endPointId = feature.get(LINE_END_POINT_ID_PROPERTY);
          let changed = false;
          if (startPointId === pointId &&
            !coordinatesMatch(lineCoordinates[0], pointCoordinates)) {
            lineCoordinates[0] = pointCoordinates;
            changed = true;
          }
          if (endPointId === pointId &&
            !coordinatesMatch(lineCoordinates[lineCoordinates.length - 1], pointCoordinates)) {
            lineCoordinates[lineCoordinates.length - 1] = pointCoordinates;
            changed = true;
          }
          if (changed) line.setCoordinates(lineCoordinates);
        }
      }

      const selectedFeature = selection.getFeatures().item(0) as Feature<Geometry> | undefined;
      const selectedGeometry = selectedFeature?.getGeometry();
      if (selectedGeometry instanceof LineString) {
        setLineDistanceKm(getLineLengthKm(selectedFeature ?? null, source.getFeatures()));
      } else if (geometry instanceof Point) {
        const pointId = getPointId(changedFeature);
        if (!pointId) return;
        const connectedLine = lineFeatures.find((feature) => (
          feature.get(LINE_START_POINT_ID_PROPERTY) === pointId ||
          feature.get(LINE_END_POINT_ID_PROPERTY) === pointId
        ));
        if (connectedLine) {
          setLineDistanceKm(getLineLengthKm(connectedLine, source.getFeatures()));
        }
      }
    });
    map.on("pointermove", (event) => {
      const [longitude, latitude] = toLonLat(event.coordinate);
      const coordinatesElement = coordinatesElementRef.current;
      if (coordinatesElement) {
        coordinatesElement.textContent = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
        coordinatesElement.hidden = false;
      }
      const start = lineStartRef.current;
      const previewFeature = previewFeatureRef.current;
      const previewGeometry = previewFeature?.getGeometry();
      const startGeometry = start?.getGeometry();
      if (startGeometry instanceof Point && previewGeometry instanceof LineString) {
        previewGeometry.setCoordinates([startGeometry.getCoordinates(), event.coordinate]);
        const distance = getLineLengthKm(previewFeature, source.getFeatures());
        if (lineDistanceElementRef.current) {
          lineDistanceElementRef.current.textContent =
            distance === null ? "—" : formatDistanceKm(distance);
        }
      }
    });

    mapRef.current = map;
    sourceRef.current = source;
    previewSourceRef.current = previewSource;
    selectRef.current = selection;
    modifyRef.current = modify;
    translateRef.current = translate;

    return () => {
      mapViewport?.removeEventListener("pointerdown", handleMapPointerDown);
      mapViewport?.removeEventListener("mousedown", preventMiddleClickDefault);
      mapViewport?.removeEventListener("auxclick", addPointAtMiddleClick);
      window.removeEventListener("pointermove", handleMapPointerMove);
      window.removeEventListener("pointerup", handleMapPointerUp);
      mapViewport?.removeEventListener("contextmenu", preventMapContextMenu);
      selectionBoxElement?.remove();
      map.setTarget(undefined);
      mapRef.current = null;
      sourceRef.current = null;
      previewSourceRef.current = null;
      previewFeatureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const source = sourceRef.current;
    const selection = selectRef.current;
    const modify = modifyRef.current;
    const translate = translateRef.current;
    if (!map || !source || !selection || !modify || !translate) return;

    if (drawRef.current) {
      map.removeInteraction(drawRef.current);
      drawRef.current = null;
    }
    selection.setActive(true);
    modify.setActive(Boolean(selected));
    translate.setActive(Boolean(selected));

    if (tool === "Point") {
      const draw = new Draw({
        source,
        type: tool,
        condition: (event) => !map.hasFeatureAtPixel(event.pixel, {
          layerFilter: (layer) =>
            layer instanceof VectorLayer && layer.getSource() === source,
          hitTolerance: 12,
        }),
      });
      draw.on("drawstart", () => {
        setLineDistanceKm(null);
        setMessage("Click the map to place a point.");
      });
      draw.on("drawend", (event) => {
        const feature = event.feature;
        feature.setProperties(styleRef.current);
        if (feature.getGeometry() instanceof Point) {
          feature.set(POINT_ID_PROPERTY, createPointId());
        }
        const features = source.getFeatures();
        commitHistory(serializeFeatures(
          features.includes(feature as Feature<Geometry>)
            ? features
            : [...features, feature as Feature<Geometry>],
        ));
        selection.clearSelection();
        selection.selectFeature(feature);
        setSelected(feature as Feature<Geometry>);
        setSelectedCount(1);
        setMessage(`${getGeometryLabel(feature as Feature<Geometry>)} added.`);
      });
      map.addInteraction(draw);
      drawRef.current = draw;
    } else if (tool === "LineString") {
      if (lineStartRef.current) {
        setMessage("Start point selected. Click another point once to confirm the line.");
      } else if (!(selected?.getGeometry() instanceof LineString)) {
        setLineDistanceKm(null);
        setMessage("Line: click a starting point, then another point to create it.");
      }
    } else {
      if (!selected) setLineDistanceKm(null);
      setMessage(
        selectedCount > 1
          ? `${selectedCount} points selected. Drag to move them together.`
          : selected
            ? "Drag to move; drag vertices to edit."
            : "Select a vector or create a new one.",
      );
    }
  }, [tool, selected, selectedCount, style]);

  const updateStyle = useCallback(
    (next: Partial<VectorProperties>) => {
      const nextStyle = { ...style, ...next };
      setStyle(nextStyle);
      const selectedFeatures = selectRef.current?.getFeatures().getArray() ?? [];
      const featuresToStyle = selectedFeatures.length > 0 ? selectedFeatures : selected ? [selected] : [];
      if (featuresToStyle.length > 0) {
        for (const feature of featuresToStyle) {
          feature.setProperties(nextStyle);
          feature.changed();
        }
        commitHistory();
      }
    },
    [selected, style],
  );

  const exportGeoJSON = useCallback(() => {
    const source = sourceRef.current;
    if (!source) return;
    const exportFeatures = source.getFeatures().map((feature) => {
      const clone = feature.clone() as Feature<Geometry>;
      clone.setId(feature.getId());
      const geometry = feature.getGeometry();
      if (geometry instanceof Point) {
        const altitude = feature.get(ALTITUDE_PROPERTY);
        const pointAltitude = typeof altitude === "number" && Number.isFinite(altitude)
          ? altitude
          : geometry.getCoordinates()[2] ?? 0;
        clone.set(ALTITUDE_PROPERTY, pointAltitude);
        const [x, y] = geometry.getCoordinates();
        clone.setGeometry(new Point([x, y]));
      }
      return clone;
    });
    const data = new GeoJSON().writeFeatures(exportFeatures, {
      featureProjection: "EPSG:3857",
      dataProjection: "EPSG:4326",
      decimals: 8,
    });
    const blob = new Blob([data], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const fileName = projectTitle
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "") || DEFAULT_PROJECT_TITLE;
    link.download = `${fileName}.geojson`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("GeoJSON exported in WGS 84 coordinates.");
  }, [projectTitle]);

  const importGeoJSON = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const features = new GeoJSON().readFeatures(text, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
      const source = sourceRef.current;
      if (!source) return;

      const importedPointIdCounts = new globalThis.Map<string, number>();
      for (const feature of features) {
        if (!(feature.getGeometry() instanceof Point)) continue;
        const id = getPointId(feature as Feature<Geometry>);
        if (id) importedPointIdCounts.set(id, (importedPointIdCounts.get(id) ?? 0) + 1);
      }
      const usedPointIds = new Set(
        source.getFeatures()
          .map(getPointId)
          .filter((id): id is string => id !== null),
      );
      const importedPointIdMap = new globalThis.Map<string, string>();
      for (const feature of features) {
        if (!(feature.getGeometry() instanceof Point)) continue;
        const typedFeature = feature as Feature<Geometry>;
        const previousId = getPointId(typedFeature);
        const canPreserveId = previousId !== null &&
          importedPointIdCounts.get(previousId) === 1 &&
          !usedPointIds.has(previousId);
        const pointId = canPreserveId ? previousId : createPointId();
        typedFeature.set(POINT_ID_PROPERTY, pointId);
        usedPointIds.add(pointId);
        if (previousId && importedPointIdCounts.get(previousId) === 1) {
          importedPointIdMap.set(previousId, pointId);
        }
      }
      for (const feature of features) {
        if (!(feature.getGeometry() instanceof LineString)) continue;
        const typedFeature = feature as Feature<Geometry>;
        for (const property of [LINE_START_POINT_ID_PROPERTY, LINE_END_POINT_ID_PROPERTY]) {
          const previousId = typedFeature.get(property);
          if (typeof previousId !== "string") continue;
          const mappedId = importedPointIdMap.get(previousId);
          if (mappedId) typedFeature.set(property, mappedId);
        }
      }

      source.addFeatures(features);
      for (const feature of features) {
        const geometry = feature.getGeometry();
        const altitude = feature.get(ALTITUDE_PROPERTY);
        if (
          geometry instanceof Point &&
          typeof altitude === "number" &&
          Number.isFinite(altitude)
        ) {
          const [x, y] = geometry.getCoordinates();
          geometry.setCoordinates([x, y, altitude]);
        }
      }
      const allPoints = source.getFeatures().filter(
        (feature) => feature.getGeometry() instanceof Point,
      );
      for (const feature of features) {
        const geometry = feature.getGeometry();
        if (!(geometry instanceof LineString)) continue;
        const typedFeature = feature as Feature<Geometry>;
        const lineCoordinates = geometry.getCoordinates();
        if (lineCoordinates.length < 2) continue;

        for (const [index, property] of [
          [0, LINE_START_POINT_ID_PROPERTY],
          [lineCoordinates.length - 1, LINE_END_POINT_ID_PROPERTY],
        ] as const) {
          const linkedPointId = typedFeature.get(property);
          const linkedPointExists = allPoints.some(
            (candidate) => getPointId(candidate as Feature<Geometry>) === linkedPointId,
          );
          if (typeof linkedPointId === "string" && linkedPointExists) continue;

          const [x, y] = lineCoordinates[index];
          const matchingPoints = allPoints.filter((candidate) => {
            const pointGeometry = candidate.getGeometry();
            if (!(pointGeometry instanceof Point)) return false;
            const [pointX, pointY] = pointGeometry.getCoordinates();
            return Math.hypot(pointX - x, pointY - y) <= 0.1;
          });
          if (matchingPoints.length === 1) {
            const pointId = getPointId(matchingPoints[0] as Feature<Geometry>);
            if (pointId) typedFeature.set(property, pointId);
          }
        }
      }
      commitHistory();
      setMessage(`${features.length} item(s) imported from GeoJSON.`);
    } catch (error) {
      console.error("Could not import the GeoJSON file.", error);
      setMessage("Could not import the file. Make sure it is valid GeoJSON.");
    }
  }, []);

  const deleteSelected = useCallback(() => {
    const source = sourceRef.current;
    if (!selected || !source) return;
    const selectedFeatures = selectRef.current?.getFeatures().getArray().slice() ?? [];
    const featuresToDelete = selectedFeatures.length > 0 ? selectedFeatures : [selected];
    if (lineStartRef.current && featuresToDelete.includes(lineStartRef.current)) {
      lineStartRef.current = null;
      previewSourceRef.current?.clear(true);
      previewFeatureRef.current = null;
    }
    const pointIdsToDelete = new Set(
      featuresToDelete
        .filter((feature) => feature.getGeometry() instanceof Point)
        .map(getPointId)
        .filter((id): id is string => id !== null),
    );
    const connectedLines = source.getFeatures().filter((feature) => {
      if (!(feature.getGeometry() instanceof LineString)) return false;
      return (
        pointIdsToDelete.has(feature.get(LINE_START_POINT_ID_PROPERTY)) ||
        pointIdsToDelete.has(feature.get(LINE_END_POINT_ID_PROPERTY))
      );
    });
    const allFeaturesToDelete = new Set([...featuresToDelete, ...connectedLines]);
    for (const feature of allFeaturesToDelete) source.removeFeature(feature);
    commitHistory();
    selectRef.current?.clearSelection();
    setSelected(null);
    setSelectedCount(0);
    setCoordinateDialogOpen(false);
    setMessage(
      allFeaturesToDelete.size === 1
        ? "Vector deleted."
        : `${allFeaturesToDelete.size} vectors deleted, including lines connected to the points.`,
    );
  }, [selected]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") modifierKeysRef.current.ctrl = true;
      if (event.key === "Meta") modifierKeysRef.current.meta = true;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selected) return;
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;

      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") modifierKeysRef.current.ctrl = false;
      if (event.key === "Meta") modifierKeysRef.current.meta = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [deleteSelected, redo, selected, undo]);

  const savePointCoordinates = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const latitude = Number(latitudeInput);
    const longitude = Number(longitudeInput);
    const altitude = altitudeInput.trim() === "" ? 0 : Number(altitudeInput);
    if (
      latitudeInput.trim() === "" ||
      longitudeInput.trim() === "" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(altitude) ||
      latitude < -MAX_MERCATOR_LATITUDE ||
      latitude > MAX_MERCATOR_LATITUDE ||
      longitude < -180 ||
      longitude > 180
    ) {
      setCoordinateError(
        `Enter a latitude between -${MAX_MERCATOR_LATITUDE} and ${MAX_MERCATOR_LATITUDE}, and a longitude between -180 and 180.`,
      );
      return;
    }

    if (!selected) {
      setCoordinateDialogOpen(false);
      return;
    }
    const geometry = selected.getGeometry();
    if (!(geometry instanceof Point)) {
      setCoordinateDialogOpen(false);
      return;
    }
    const projectedPosition = fromLonLat([longitude, latitude]);
    geometry.setCoordinates([projectedPosition[0], projectedPosition[1], altitude]);
    selected.set(ALTITUDE_PROPERTY, altitude);
    selected.changed();
    const pointId = getPointId(selected);
    const connectedLine = pointId
      ? sourceRef.current?.getFeatures().find((feature) => (
        feature.getGeometry() instanceof LineString &&
        (
          feature.get(LINE_START_POINT_ID_PROPERTY) === pointId ||
          feature.get(LINE_END_POINT_ID_PROPERTY) === pointId
        )
      ))
      : undefined;
    if (connectedLine) {
      setLineDistanceKm(
        getLineLengthKm(connectedLine, sourceRef.current?.getFeatures() ?? []),
      );
    }
    commitHistory();
    setCoordinateDialogOpen(false);
    setMessage("Point coordinates and elevation updated.");
  };

  const setActiveTool = (nextTool: Tool) => {
    const targetTool = tool === nextTool ? "auto" : nextTool;
    activeToolRef.current = targetTool;
    lineStartRef.current = null;
    previewSourceRef.current?.clear(true);
    previewFeatureRef.current = null;
    setTool(targetTool);
    setCoordinateDialogOpen(false);
  };

  const centerOnUserLocation = () => {
    if (!navigator.geolocation) {
      setMessage("This browser does not support device location.");
      return;
    }
    setLocatingUser(true);
    setMessage("Requesting permission to access your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        mapRef.current?.getView().animate({
          center: fromLonLat([longitude, latitude]),
          zoom: 15,
          duration: 650,
        });
        setLocatingUser(false);
        setMessage("Map centered on your current location.");
      },
      (error) => {
        setLocatingUser(false);
        if (error.code === error.PERMISSION_DENIED) {
          setMessage("Could not access your location. Allow location access in your browser and try again.");
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setMessage("Your device could not determine your location.");
        } else {
          setMessage("The request for your location timed out. Please try again.");
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };

  const acceptTerms = () => {
    try {
      window.localStorage.setItem(TERMS_STORAGE_KEY, TERMS_VERSION);
      setTermsAccepted(true);
    } catch (error) {
      console.error("Could not save the terms and privacy acceptance.", error);
      setTermsStorageError(
        "Could not save your acceptance in this browser. Enable local storage and try again.",
      );
    }
  };

  const startEditingProjectTitle = () => {
    cancelProjectTitleBlurRef.current = false;
    setProjectTitleDraft(projectTitle);
    setEditingProjectTitle(true);
    window.requestAnimationFrame(() => projectTitleInputRef.current?.select());
  };

  const saveProjectTitle = () => {
    const nextTitle = projectTitleDraft.trim() || DEFAULT_PROJECT_TITLE;
    try {
      window.localStorage.setItem(PROJECT_TITLE_STORAGE_KEY, nextTitle);
      setProjectTitle(nextTitle);
      setEditingProjectTitle(false);
    } catch (error) {
      console.error("Could not save the project title.", error);
      setMessage("Could not save the project title in this browser.");
      setEditingProjectTitle(false);
    }
  };

  const cancelProjectTitleEdit = () => {
    cancelProjectTitleBlurRef.current = true;
    setEditingProjectTitle(false);
    setProjectTitleDraft("");
  };

  return (
    <main className="workspace">
      <header className="topbar">
        <a className="brand" href="/" aria-label="GeoVec home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 36 36" fill="none">
              <path d="M18 29s9-8.1 9-15a9 9 0 1 0-18 0c0 6.9 9 15 9 15Z" className="brand-pin" />
              <circle cx="18" cy="14" r="3" className="brand-pin-center" />
            </svg>
          </span>
          <span>Geo<span>Vec</span></span>
        </a>
        <div className="project-name">
          <span className="project-dot" />
          {editingProjectTitle ? (
            <input
              aria-label="Project title"
              autoFocus
              className="project-title-input"
              maxLength={80}
              onBlur={() => {
                if (cancelProjectTitleBlurRef.current) {
                  cancelProjectTitleBlurRef.current = false;
                  return;
                }
                saveProjectTitle();
              }}
              onChange={(event) => setProjectTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveProjectTitle();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelProjectTitleEdit();
                }
              }}
              ref={projectTitleInputRef}
              value={projectTitleDraft}
            />
          ) : (
            <button
              aria-label={`Edit project title: ${projectTitle}`}
              className="project-title-button"
              onClick={startEditingProjectTitle}
              onDoubleClick={startEditingProjectTitle}
              title="Click to edit the title"
              type="button"
            >
              {projectTitle}
            </button>
          )}
          <span className="save-state">This session only</span>
        </div>
        <div className="top-actions">
          <button
            aria-label="Undo (Ctrl+Z)"
            className="button button-quiet history-button"
            disabled={!canUndo}
            onClick={undo}
            title="Undo (Ctrl+Z)"
            type="button"
          >
            ↶
          </button>
          <button
            aria-label="Redo (Ctrl+Y)"
            className="button button-quiet history-button"
            disabled={!canRedo}
            onClick={redo}
            title="Redo (Ctrl+Y)"
            type="button"
          >
            ↷
          </button>
          <button className="button button-quiet" onClick={() => fileInputRef.current?.click()} type="button">
            <span aria-hidden="true">↑</span> Import
          </button>
          <button className="button button-primary" onClick={exportGeoJSON} type="button">
            Export GeoJSON <span aria-hidden="true">↓</span>
          </button>
          <input
            ref={fileInputRef}
            accept=".geojson,.json,application/geo+json,application/json"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importGeoJSON(file);
              event.currentTarget.value = "";
            }}
            type="file"
          />
        </div>
      </header>

      <section className="editor">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="overline">WORKSPACE</p>
              <h1>Map editor</h1>
            </div>
            <button className="icon-button" aria-label="More options" title="More options" type="button">···</button>
          </div>
          <div className="tool-section">
            <p className="section-label">TOOLS</p>
            <div className="tool-list" role="group" aria-label="Drawing tools">
              <ToolButton active={tool === "Point"} icon="•" label="Point" onClick={() => setActiveTool("Point")} />
              <ToolButton active={tool === "LineString"} icon="╱" label="Line" onClick={() => setActiveTool("LineString")} />
            </div>
            {tool !== "LineString" && (
              <p className="tool-hint">
                {tool === "auto"
                  ? "Selection and editing are always available. Click the middle mouse button to place a point; right-drag to select an area, or Ctrl + left-click to toggle individual points."
                  : "Click an empty area to place a point. You can also select and move existing vectors; Point mode remains active."}
              </p>
            )}
          </div>

          <div className="divider" />
          <div className="properties">
            {tool === "LineString" && (
              <div className="line-measurement" aria-live="polite">
                <span>3D geodesic distance</span>
                <strong ref={lineDistanceElementRef}>{lineDistanceKm === null ? "—" : formatDistanceKm(lineDistanceKm)}</strong>
                {lineDistanceKm === null && (
                  <small>Select a line or choose two points to draw one.</small>
                )}
                {lineStartRef.current && (
                  <small>Live preview; click another point to confirm.</small>
                )}
              </div>
            )}
            {selected && (
              <>
                <div className="properties-title">
                  <p className="section-label">VECTOR STYLE</p>
                  <span className="property-kind">{getGeometryLabel(selected)}</span>
                </div>
                {tool !== "LineString" && lineDistanceKm !== null && (
                  <div className="line-measurement" aria-live="polite">
                    <span>3D geodesic distance</span>
                    <strong>{formatDistanceKm(lineDistanceKm)}</strong>
                  </div>
                )}
                <label className="color-row">
                  <span>Stroke color</span>
                  <span className="color-control">
                    <input aria-label="Stroke color" onChange={(event) => updateStyle({ color: event.target.value })} type="color" value={style.color} />
                    <span>{style.color.toUpperCase()}</span>
                  </span>
                </label>
                <label className="range-row">
                  <span>Width <output>{style.width}px</output></span>
                  <input
                    aria-label="Stroke width"
                    max="12"
                    min="1"
                    onChange={(event) => updateStyle({ width: Number(event.target.value) })}
                    type="range"
                    value={style.width}
                  />
                </label>
                <label className="range-row">
                  <span>Opacity <output>{Math.round(style.opacity * 100)}%</output></span>
                  <input
                    aria-label="Vector opacity"
                    max="1"
                    min="0.1"
                    onChange={(event) => updateStyle({ opacity: Number(event.target.value) })}
                    step="0.05"
                    type="range"
                    value={style.opacity}
                  />
                </label>
                <button className="delete-button" onClick={deleteSelected} type="button">
                  <span aria-hidden="true">×</span> {selectedCount > 1 ? `Delete ${selectedCount} points` : "Delete vector"}
                </button>
              </>
            )}
          </div>
          <div className="sidebar-spacer" />
          {tool !== "LineString" && (
            <div className="help-card">
              <span className="help-icon">i</span>
              <div>
                <strong>Quick tip</strong>
                <p>Line: click two existing points to create a connection.</p>
              </div>
            </div>
          )}
        </aside>

        <section className="map-panel" aria-label="Map editor">
          <div ref={mapElement} className="map-canvas" />
          <div
            className="location-search"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setLocationSearchOpen(false);
              }
            }}
          >
            <span className="location-search-icon" aria-hidden="true">⌕</span>
            <input
              aria-activedescendant={
                activeLocationIndex >= 0
                  ? `location-result-${activeLocationIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls="location-search-results"
              aria-expanded={locationSearchOpen}
              aria-label="Search for a location"
              autoComplete="off"
              onChange={(event) => {
                setLocationQuery(event.target.value);
                setLocationSearchOpen(true);
                setLocationSearchError("");
              }}
              onFocus={() => setLocationSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && locationResults.length > 0) {
                  event.preventDefault();
                  setActiveLocationIndex((index) => (index + 1) % locationResults.length);
                } else if (event.key === "ArrowUp" && locationResults.length > 0) {
                  event.preventDefault();
                  setActiveLocationIndex((index) =>
                    index <= 0 ? locationResults.length - 1 : index - 1,
                  );
                } else if (event.key === "Enter" && locationResults.length > 0) {
                  event.preventDefault();
                  goToLocation(locationResults[Math.max(activeLocationIndex, 0)]);
                } else if (event.key === "Escape") {
                  setLocationSearchOpen(false);
                  setActiveLocationIndex(-1);
                }
              }}
              placeholder="Search places"
              role="combobox"
              value={locationQuery}
            />
            {locationQuery && (
              <button
                aria-label="Clear search"
                className="location-search-clear"
                onClick={() => {
                  setLocationQuery("");
                  setLocationResults([]);
                  setLocationSearchOpen(true);
                }}
                type="button"
              >
                ×
              </button>
            )}
            {locationSearchOpen && locationQuery.trim().length >= 2 && (
              <div
                className="location-search-results"
                id="location-search-results"
                role="listbox"
              >
                {locationSearchLoading && (
                  <div className="location-search-message" role="status">Searching locations…</div>
                )}
                {!locationSearchLoading && locationSearchError && (
                  <div className="location-search-message location-search-error" role="alert">
                    {locationSearchError}
                  </div>
                )}
                {!locationSearchLoading && !locationSearchError && locationResults.length === 0 && (
                  <div className="location-search-message" role="status">No locations found.</div>
                )}
                {!locationSearchLoading && locationResults.map((location, index) => (
                  <button
                    aria-selected={activeLocationIndex === index}
                    className={`location-result${activeLocationIndex === index ? " active" : ""}`}
                    id={`location-result-${index}`}
                    key={location.id}
                    onClick={() => goToLocation(location)}
                    onMouseEnter={() => setActiveLocationIndex(index)}
                    role="option"
                    type="button"
                  >
                    <span aria-hidden="true" className="location-result-pin">⌖</span>
                    <span className="location-result-copy">
                      <strong>{location.label}</strong>
                      {location.detail && <small>{location.detail}</small>}
                    </span>
                  </button>
                ))}
                <div className="location-search-attribution">Photon · © OpenStreetMap contributors</div>
              </div>
            )}
          </div>
          <div className="map-toolbar">
            <button className="map-control" onClick={() => mapRef.current?.getView().setZoom((mapRef.current?.getView().getZoom() ?? 5) + 1)} aria-label="Zoom in" title="Zoom in" type="button">+</button>
            <button className="map-control" onClick={() => mapRef.current?.getView().setZoom((mapRef.current?.getView().getZoom() ?? 5) - 1)} aria-label="Zoom out" title="Zoom out" type="button">−</button>
            <span className="control-separator" />
            <button
              aria-label="Center on my location"
              className="map-control locate-control"
              disabled={locatingUser}
              onClick={centerOnUserLocation}
              title="Center on my location"
              type="button"
            >
              ◎
            </button>
          </div>
          <div className="map-label">
            <span className="map-label-dot" />
            <span>World map</span>
            <span className="coordinate-system">WGS 84</span>
          </div>
          <div className="map-status">
            <span className="status-message">{message}</span>
            <span className="coordinates" hidden ref={coordinatesElementRef} />
          </div>
          <div className="feature-counter">{featureCount} {featureCount === 1 ? "vector" : "vectors"}</div>
        </section>
      </section>
      <footer className="app-footer">
        <span><i className="online-dot" /> Lines between existing points</span>
        <span>© OpenStreetMap contributors</span>
      </footer>
      {coordinateDialogOpen && selected?.getGeometry() instanceof Point && (
        <div
          className="dialog-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setCoordinateDialogOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setCoordinateDialogOpen(false);
          }}
        >
          <form
            aria-labelledby="coordinate-dialog-title"
            aria-modal="true"
            className="coordinate-dialog"
            onSubmit={savePointCoordinates}
            role="dialog"
          >
            <div className="dialog-heading">
              <div>
                <p className="overline">GEOREFERENCED POINT</p>
                <h2 id="coordinate-dialog-title">Edit coordinates</h2>
              </div>
              <button
                aria-label="Close"
                className="icon-button"
                onClick={() => setCoordinateDialogOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <p className="dialog-description">
              Adjust the WGS 84 coordinates. Elevation is optional; if left blank, it defaults to 0 m above sea level.
            </p>
            <div className="coordinate-fields">
              <label>
                <span>Latitude</span>
                <input
                  autoFocus
                  max={MAX_MERCATOR_LATITUDE}
                  min={-MAX_MERCATOR_LATITUDE}
                  onChange={(event) => setLatitudeInput(event.target.value)}
                  placeholder="40.41680000"
                  step="any"
                  type="number"
                  value={latitudeInput}
                />
              </label>
              <label>
                <span>Longitude</span>
                <input
                  max="180"
                  min="-180"
                  onChange={(event) => setLongitudeInput(event.target.value)}
                  placeholder="-3.70380000"
                  step="any"
                  type="number"
                  value={longitudeInput}
                />
              </label>
              <label className="altitude-field">
                <span>Elevation (m, optional)</span>
                <input
                  onChange={(event) => setAltitudeInput(event.target.value)}
                  placeholder="0 = sea level"
                  step="any"
                  type="number"
                  value={altitudeInput}
                />
              </label>
            </div>
            {coordinateError && <p className="coordinate-error" role="alert">{coordinateError}</p>}
            <div className="dialog-actions">
              <button className="button button-quiet" onClick={() => setCoordinateDialogOpen(false)} type="button">
                Cancel
              </button>
              <button className="button button-primary" type="submit">Save position</button>
            </div>
          </form>
        </div>
      )}
      {!termsAccepted && (
        <div className="dialog-backdrop terms-backdrop">
          <section
            aria-labelledby="terms-dialog-title"
            aria-modal="true"
            className="terms-dialog"
            role="dialog"
          >
            <div className="terms-heading">
              <p className="overline">BEFORE YOU START</p>
              <h2 id="terms-dialog-title">Terms and privacy</h2>
              <p>Review how GeoVec works and what data it uses.</p>
            </div>
            <div className="terms-content">
              <section aria-labelledby="terms-use-title">
                <h3 id="terms-use-title">Terms of use</h3>
                <p>
                  GeoVec is a map-editing tool. You are responsible for the vectors
                  you create, import, and share, and for verifying that coordinates
                  and measurements are suitable for your intended use. Distances are
                  geodesic estimates and are not a substitute for professional or
                  field measurements.
                </p>
                <p>
                  The map and search depend on external services and may not always
                  be available. Respect the licenses and attribution requirements
                  for OpenStreetMap map data.
                </p>
              </section>
              <section aria-labelledby="terms-privacy-title">
                <h3 id="terms-privacy-title">Privacy</h3>
                <ul>
                  <li>
                    GeoVec does not create accounts or send your vectors to its own
                    server. Your project remains in this session's memory until you
                    export it.
                  </li>
                  <li>
                    When you search for a place, your search text is sent to Photon
                    (Komoot), which provides results based on OpenStreetMap. The
                    provider may receive technical connection data and applies its
                    own privacy policies.
                  </li>
                  <li>
                    The map loads tiles from OpenStreetMap; that service may receive
                    technical connection data.
                  </li>
                  <li>
                    Your device location is only requested when you select
                    “Center on my location.” Your browser manages the permission,
                    and GeoVec uses the coordinates to center the map.
                  </li>
                  <li>
                    Your acceptance is saved in your browser's local storage so this
                    notice is not shown again on this device.
                  </li>
                </ul>
              </section>
            </div>
            {termsStorageError && (
              <p className="terms-error" role="alert">{termsStorageError}</p>
            )}
            <div className="terms-actions">
              <button className="button button-primary" onClick={acceptTerms} type="button">
                Accept and continue
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

type ToolButtonProps = {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
};

function ToolButton({ active, icon, label, onClick }: ToolButtonProps) {
  return (
    <button
      aria-pressed={active}
      className={`tool-button${active ? " active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <span className="tool-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {active && <span className="active-marker" />}
    </button>
  );
}
