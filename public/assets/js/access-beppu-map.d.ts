export type Category = '昼食' | '朝食' | '夕食' | 'お酒' | '喫茶' | 'お買いもの' | '散歩' | '駐車場' | '温泉';

export interface Place {
  id: string;
  placeId?: string;
  name: string;
  slug: string;
  category: Category;
  tags?: string;
  subcategory?: Category;
  lat: number;
  lng: number;
  thumbnail?: string;
  description?: string;
  businessHours?: string | Record<string, Array<{ open: string; close: string }>>;
  businessHoursText?: string;
  cardElement?: HTMLElement;
}

export interface RouteSummary {
  duration: string;
  distance: string;
  isFallback: boolean;
  label: string;
  modeLabel?: string;
}

export interface PageState {
  activeCategory: Category | '';
  activeSubcategory: Category | '';
  selectedPlaceId: string | null;
  mobile: boolean;
}

export interface BeppuMapModuleOptions {
  mapElement: HTMLElement;
  listElement: HTMLElement;
  routeChipElement: HTMLElement;
  places: Place[];
  hotel?: { lat: number; lng: number; name: string };
  station?: { lat: number; lng: number; name: string };
  zoom?: number;
  adaptiveNearDistanceMeters?: number;
  adaptiveZoomStep?: number;
  adaptiveZoomMax?: number;
  walkToDriveThresholdMinutes?: number;
  idleRouteMessage?: string;
  fallbackMessage?: string;
  onPlaceSelected?: (placeId: string | null) => void;
}

export declare class BeppuMapModule {
  constructor(options: BeppuMapModuleOptions);
  init(): Promise<void>;
  selectPlace(placeId: string): Promise<void>;
  clearSelection(): Promise<void>;
  setPlaceVisibility(visiblePlaceIds: string[]): void;
  drawRoute(
    origin: { lat: number; lng: number; name: string },
    destination: { lat: number; lng: number; name: string }
  ): Promise<RouteSummary>;
}

export declare function mapWebflowCmsItemsToPlaces(response: unknown): Place[];
export declare function extractPlacesFromWebflowDom(root: ParentNode): Place[];
export declare function normalizeCategory(value: unknown, fallback: Category): Category;
