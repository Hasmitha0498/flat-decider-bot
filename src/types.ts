// Shared domain types. No Telegram, Gemini or database code in here.

export type Importance = 'must_have' | 'prefer' | 'no_preference';

/** The four states every (person, criterion, flat) combination ends up in. */
export type MatchState = 'match' | 'fail' | 'unknown' | 'not_relevant';

export const CRITERIA = [
  'city',
  'max_rent',
  'areas',
  'excluded_areas',
  'commute',
  'bhk',
  'bathrooms',
  'lift',
  'parking',
  'furnishing',
  'pets',
  'food',
  'balcony',
  'gated_community',
  'metro',
  'additional',
] as const;
export type Criterion = (typeof CRITERIA)[number];

export type Furnishing = 'fully_furnished' | 'semi_furnished' | 'unfurnished';
export type FoodPreference = 'non_veg_allowed' | 'veg_only_ok';

export interface CommuteWish {
  destination: string;
  max_minutes: number;
}

export interface AdditionalWish {
  text: string; // what the person typed
  check: string; // yes/no question Gemini normalised it into (or the raw text)
}

/**
 * desired_value per criterion (null always means "doesn't matter"):
 *  city: string · max_rent: number · areas / excluded_areas: string[]
 *  commute: CommuteWish · bhk: number (4 = 4+) · bathrooms: number (minimum)
 *  lift / parking / pets / balcony / gated_community / metro: boolean
 *  furnishing: Furnishing · food: FoodPreference · additional: AdditionalWish
 */
export interface Preference {
  criterion: Criterion;
  desired_value: unknown;
  importance: Importance;
}

export interface Member {
  id: string;
  group_id: string;
  telegram_user_id: number | null;
  telegram_username: string | null;
  display_name: string;
  preferences_complete: boolean;
  state: ChatState | null;
}

export interface Group {
  id: string;
  name: string;
  join_code: string;
  created_by: number | null;
  status: 'active' | 'closed';
  is_demo: boolean;
  created_at: string;
}

export type ListingStatus = 'pending' | 'extracted' | 'unreadable' | 'failed';

export interface Listing {
  id: string;
  group_id: string;
  submitted_by: string;
  url: string;
  normalized_url: string;
  manual_text: string | null;
  status: ListingStatus;
  status_detail: string | null;
  created_at: string;
}

/** Normalised facts about one flat. null = the listing does not say (UNKNOWN). */
export interface ListingFacts {
  title: string | null;
  rent_total: number | null; // whole-flat monthly rent in rupees
  location: string | null; // locality / area
  city: string | null;
  bhk: number | null;
  bathrooms: number | null;
  lift: boolean | null;
  parking: boolean | null;
  pets_allowed: boolean | null;
  food_restriction: 'vegetarian_only' | 'no_restriction' | null;
  furnishing: Furnishing | null;
  balcony: boolean | null;
  gated_community: boolean | null;
  metro_nearby: boolean | null;
  source_confidence: Record<string, 'confirmed' | 'unknown'>;
}

export type CustomAnswer = 'yes' | 'no' | 'unknown';

/** Answers to members' free-text requirements, keyed by member id. */
export type CustomAnswers = Record<string, CustomAnswer>;

/** Where a member is in the chat flow. Stored in members.state. */
export type ChatState =
  | {
      kind: 'questionnaire';
      mode: 'setup' | 'edit';
      index: number; // which question
      stage: 'value' | 'second' | 'importance';
      pending?: unknown; // answer waiting for its importance / second step
    }
  | { kind: 'awaiting_url' }
  | { kind: 'awaiting_manual_text'; listingId: string };
