import { CountryCode } from "./countries";

export interface FulfillmentLocation {
  id: string;
  optionId: string;
  countryCode: CountryCode;
  city: string;
  name: string;
  addressLine: string;
  hours: string;
  distanceLabel: string;
  mapX: number;
  mapY: number;
}

export const FULFILLMENT_LOCATIONS: FulfillmentLocation[] = [
  // ===== NIGERIA — Lagos (10) =====
  { id: "ng-box-yaba", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box · Yaba", addressLine: "Plot 14, Herbert Macaulay Way, Yaba", hours: "24/7", distanceLabel: "0.8 km", mapX: 35, mapY: 42 },
  { id: "ng-box-surulere", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box · Surulere", addressLine: "Adeniran Ogunsanya Mall, Surulere", hours: "24/7", distanceLabel: "1.2 km", mapX: 32, mapY: 55 },
  { id: "ng-box-lekki1", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box · Lekki Phase 1", addressLine: "Admiralty Way, Lekki Phase 1", hours: "24/7", distanceLabel: "3.4 km", mapX: 65, mapY: 60 },
  { id: "ng-box-vi", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box · Victoria Island", addressLine: "1004 Estate, Victoria Island", hours: "24/7", distanceLabel: "5.1 km", mapX: 55, mapY: 65 },
  { id: "ng-box-ikeja", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box · Ikeja City Mall", addressLine: "Obafemi Awolowo Way, Alausa", hours: "8am – 10pm", distanceLabel: "7.2 km", mapX: 38, mapY: 25 },
  { id: "ng-pudo-mushin", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Mama T Provisions (PUDO)", addressLine: "23 Olosa St, Mushin", hours: "8am – 8pm", distanceLabel: "2.1 km", mapX: 30, mapY: 35 },
  { id: "ng-pudo-ajah", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Bayo Mart (PUDO)", addressLine: "Lekki-Epe Expy, Ajah", hours: "7am – 9pm", distanceLabel: "9.5 km", mapX: 80, mapY: 65 },
  { id: "ng-pudo-festac", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "FestyShop (PUDO)", addressLine: "4th Ave, Festac Town", hours: "9am – 7pm", distanceLabel: "12.3 km", mapX: 18, mapY: 65 },
  { id: "ng-pudo-gbagada", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Chika & Sons (PUDO)", addressLine: "Diya St, Gbagada Phase 2", hours: "8am – 9pm", distanceLabel: "4.8 km", mapX: 48, mapY: 35 },
  { id: "ng-pudo-ikoyi", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Ikoyi Express (PUDO)", addressLine: "Awolowo Rd, Ikoyi", hours: "8am – 8pm", distanceLabel: "6.0 km", mapX: 50, mapY: 60 },

  // ===== NIGERIA — Abuja (5) =====
  { id: "ng-box-wuse2", optionId: "epplaa-box", countryCode: "NG", city: "Abuja", name: "Epplaa Box · Wuse 2", addressLine: "Aminu Kano Cres, Wuse 2", hours: "24/7", distanceLabel: "1.5 km", mapX: 45, mapY: 40 },
  { id: "ng-box-maitama", optionId: "epplaa-box", countryCode: "NG", city: "Abuja", name: "Epplaa Box · Maitama", addressLine: "Aguiyi Ironsi St, Maitama", hours: "24/7", distanceLabel: "3.1 km", mapX: 50, mapY: 30 },
  { id: "ng-box-garki", optionId: "epplaa-box", countryCode: "NG", city: "Abuja", name: "Epplaa Box · Garki II", addressLine: "Gimbiya St, Garki II", hours: "24/7", distanceLabel: "2.4 km", mapX: 48, mapY: 55 },
  { id: "ng-pudo-jabi", optionId: "pudo", countryCode: "NG", city: "Abuja", name: "Jabi Lake Mall (PUDO)", addressLine: "Bala Sokoto Way, Jabi", hours: "9am – 9pm", distanceLabel: "5.6 km", mapX: 35, mapY: 35 },
  { id: "ng-pudo-asokoro", optionId: "pudo", countryCode: "NG", city: "Abuja", name: "Asokoro Quick Stop (PUDO)", addressLine: "Yedseram St, Asokoro", hours: "8am – 8pm", distanceLabel: "4.2 km", mapX: 60, mapY: 50 },

  // ===== NIGERIA — Port Harcourt (3) =====
  { id: "ng-box-gra-ph", optionId: "epplaa-box", countryCode: "NG", city: "Port Harcourt", name: "Epplaa Box · Old GRA", addressLine: "Aba Rd, Old GRA", hours: "24/7", distanceLabel: "1.8 km", mapX: 45, mapY: 45 },
  { id: "ng-pudo-trans", optionId: "pudo", countryCode: "NG", city: "Port Harcourt", name: "Trans-Amadi Mart (PUDO)", addressLine: "Trans-Amadi Industrial Layout", hours: "7am – 9pm", distanceLabel: "3.5 km", mapX: 60, mapY: 60 },
  { id: "ng-pudo-rumuomasi", optionId: "pudo", countryCode: "NG", city: "Port Harcourt", name: "Rumuomasi Plaza (PUDO)", addressLine: "Rumuomasi Roundabout", hours: "8am – 8pm", distanceLabel: "5.0 km", mapX: 35, mapY: 55 },

  // ===== NIGERIA — Ibadan (2) =====
  { id: "ng-box-bodija", optionId: "epplaa-box", countryCode: "NG", city: "Ibadan", name: "Epplaa Box · Bodija", addressLine: "Awolowo Ave, Bodija", hours: "24/7", distanceLabel: "1.9 km", mapX: 50, mapY: 45 },
  { id: "ng-pudo-dugbe", optionId: "pudo", countryCode: "NG", city: "Ibadan", name: "Dugbe Cash & Carry (PUDO)", addressLine: "Dugbe Market, Dugbe", hours: "8am – 7pm", distanceLabel: "3.6 km", mapX: 40, mapY: 60 },

  // ===== GHANA — Accra (5) =====
  { id: "gh-box-osu", optionId: "epplaa-box-accra", countryCode: "GH", city: "Accra", name: "Epplaa Box · Osu", addressLine: "Oxford St, Osu", hours: "24/7", distanceLabel: "1.0 km", mapX: 50, mapY: 55 },
  { id: "gh-box-east-legon", optionId: "epplaa-box-accra", countryCode: "GH", city: "Accra", name: "Epplaa Box · East Legon", addressLine: "Lagos Ave, East Legon", hours: "24/7", distanceLabel: "4.5 km", mapX: 65, mapY: 35 },
  { id: "gh-box-airport", optionId: "epplaa-box-accra", countryCode: "GH", city: "Accra", name: "Epplaa Box · Airport City", addressLine: "Airport City, Accra", hours: "24/7", distanceLabel: "6.2 km", mapX: 55, mapY: 30 },
  { id: "gh-pudo-mada", optionId: "speedaf-pickup", countryCode: "GH", city: "Accra", name: "Speedaf · Madina", addressLine: "Madina Old Road", hours: "8am – 8pm", distanceLabel: "9.8 km", mapX: 70, mapY: 25 },
  { id: "gh-pudo-circle", optionId: "speedaf-pickup", countryCode: "GH", city: "Accra", name: "Speedaf · Circle", addressLine: "Kwame Nkrumah Circle", hours: "7am – 9pm", distanceLabel: "3.1 km", mapX: 40, mapY: 50 },

  // ===== KENYA — Nairobi (5) =====
  { id: "ke-box-westlands", optionId: "epplaa-box-nbo", countryCode: "KE", city: "Nairobi", name: "Epplaa Box · Westlands", addressLine: "Westlands Square, Westlands", hours: "24/7", distanceLabel: "1.2 km", mapX: 35, mapY: 40 },
  { id: "ke-box-kileleshwa", optionId: "epplaa-box-nbo", countryCode: "KE", city: "Nairobi", name: "Epplaa Box · Kileleshwa", addressLine: "Ring Rd, Kileleshwa", hours: "24/7", distanceLabel: "3.0 km", mapX: 45, mapY: 50 },
  { id: "ke-box-cbd", optionId: "epplaa-box-nbo", countryCode: "KE", city: "Nairobi", name: "Epplaa Box · CBD", addressLine: "Tom Mboya St, CBD", hours: "24/7", distanceLabel: "4.5 km", mapX: 50, mapY: 60 },
  { id: "ke-pudo-karen", optionId: "g4s-pickup", countryCode: "KE", city: "Nairobi", name: "G4S · Karen", addressLine: "Karen Shopping Centre", hours: "8am – 8pm", distanceLabel: "11.0 km", mapX: 25, mapY: 75 },
  { id: "ke-pudo-thika", optionId: "g4s-pickup", countryCode: "KE", city: "Nairobi", name: "G4S · Thika Rd Mall", addressLine: "Thika Superhighway", hours: "9am – 9pm", distanceLabel: "12.5 km", mapX: 70, mapY: 30 },

  // ===== SOUTH AFRICA — Johannesburg (5) =====
  { id: "za-box-sandton", optionId: "pargo-locker", countryCode: "ZA", city: "Johannesburg", name: "Pargo Locker · Sandton City", addressLine: "Sandton City Mall, Sandton", hours: "24/7", distanceLabel: "1.5 km", mapX: 50, mapY: 35 },
  { id: "za-box-rosebank", optionId: "pargo-locker", countryCode: "ZA", city: "Johannesburg", name: "Pargo Locker · Rosebank Mall", addressLine: "Rosebank Mall, Rosebank", hours: "24/7", distanceLabel: "3.0 km", mapX: 45, mapY: 45 },
  { id: "za-box-melrose", optionId: "pargo-locker", countryCode: "ZA", city: "Johannesburg", name: "Pargo Locker · Melrose Arch", addressLine: "Melrose Arch Square", hours: "24/7", distanceLabel: "4.2 km", mapX: 55, mapY: 50 },
  { id: "za-pudo-soweto", optionId: "paxi-pickup", countryCode: "ZA", city: "Johannesburg", name: "PEP Paxi · Maponya Mall", addressLine: "Maponya Mall, Soweto", hours: "8am – 7pm", distanceLabel: "18.0 km", mapX: 25, mapY: 70 },
  { id: "za-pudo-randburg", optionId: "paxi-pickup", countryCode: "ZA", city: "Johannesburg", name: "PEP Paxi · Randburg", addressLine: "Cresta Shopping Centre", hours: "8am – 8pm", distanceLabel: "8.5 km", mapX: 30, mapY: 25 },

  // ===== CÔTE D'IVOIRE — Abidjan (5) =====
  { id: "ci-box-cocody", optionId: "epplaa-box-abj", countryCode: "CI", city: "Abidjan", name: "Point Relais Epplaa · Cocody", addressLine: "Bd Latrille, Cocody", hours: "24/7", distanceLabel: "1.3 km", mapX: 55, mapY: 35 },
  { id: "ci-box-plateau", optionId: "epplaa-box-abj", countryCode: "CI", city: "Abidjan", name: "Point Relais Epplaa · Plateau", addressLine: "Av. Chardy, Plateau", hours: "24/7", distanceLabel: "2.8 km", mapX: 50, mapY: 50 },
  { id: "ci-box-marcory", optionId: "epplaa-box-abj", countryCode: "CI", city: "Abidjan", name: "Point Relais Epplaa · Marcory", addressLine: "Bd VGE, Marcory", hours: "24/7", distanceLabel: "5.5 km", mapX: 45, mapY: 65 },
  { id: "ci-pudo-yopougon", optionId: "pickup-ci", countryCode: "CI", city: "Abidjan", name: "Point Relais · Yopougon", addressLine: "Yopougon Andokoi", hours: "8am – 8pm", distanceLabel: "12.0 km", mapX: 25, mapY: 50 },
  { id: "ci-pudo-treichville", optionId: "pickup-ci", countryCode: "CI", city: "Abidjan", name: "Point Relais · Treichville", addressLine: "Av 16, Treichville", hours: "9am – 9pm", distanceLabel: "4.0 km", mapX: 50, mapY: 60 },
];

export function getLocationsForCountry(
  code: CountryCode,
  optionId?: string,
): FulfillmentLocation[] {
  return FULFILLMENT_LOCATIONS.filter(
    (loc) => loc.countryCode === code && (!optionId || loc.optionId === optionId),
  );
}

export function getLocationById(id: string): FulfillmentLocation | undefined {
  return FULFILLMENT_LOCATIONS.find((loc) => loc.id === id);
}
