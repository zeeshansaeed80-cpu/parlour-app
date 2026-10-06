// Starting categories and payment methods. Written to the database once, on first
// sign-in. After that they live in the database and can be edited (Stage 2).
export const SEED_VERSION = 1;

const INCOME = {
  "Hair": ["Haircut", "Blow-dry", "Hair colour", "Highlights", "Hair treatment", "Hair styling"],
  "Skin": ["Facial", "Cleansing", "Polisher", "Bleach"],
  "Hair removal": ["Waxing", "Threading"],
  "Makeup": ["Party makeup", "Bridal makeup", "Nikkah/Engagement makeup"],
  "Hands & feet": ["Manicure", "Pedicure", "Nails"],
  "Mehndi": ["Hand mehndi", "Bridal mehndi"],
  "Packages": ["Bridal package", "Deals"]
};

const EXPENSE = {
  "Premises": ["Shop rent", "Maintenance & repairs"],
  "Staff": ["Salaries", "Commission", "Eid bonus"],
  "Products & supplies": ["Hair products", "Skin products", "Makeup", "Wax & disposables"],
  "Utilities": ["Electricity", "Gas", "Water", "Internet & mobile"],
  "Equipment": ["Purchase", "Repair"],
  "Marketing": ["Social media ads", "Printing"],
  "Other": ["Transport", "Tea & refreshments", "Miscellaneous"]
};

export function slug(s) {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Fixed IDs (e.g. "inc-skin-facial") so seeding twice can never create duplicates.
export function buildDefaultCategories() {
  const out = [];
  const add = (type, prefix, tree) => {
    Object.entries(tree).forEach(([main, subs], i) => {
      const mainId = `${prefix}-${slug(main)}`;
      out.push({ id: mainId, type, name: main, parentId: null, sortOrder: i, active: true });
      subs.forEach((sub, j) => {
        out.push({ id: `${mainId}-${slug(sub)}`, type, name: sub, parentId: mainId, sortOrder: j, active: true });
      });
    });
  };
  add("income", "inc", INCOME);
  add("expense", "exp", EXPENSE);
  return out;
}

export const DEFAULT_PAYMENT_METHODS = [
  { id: "pm-cash", kind: "paymentMethod", name: "Cash", sortOrder: 0, active: true },
  { id: "pm-bank", kind: "paymentMethod", name: "Bank transfer", sortOrder: 1, active: true },
  { id: "pm-jazzcash", kind: "paymentMethod", name: "JazzCash", sortOrder: 2, active: true },
  { id: "pm-easypaisa", kind: "paymentMethod", name: "Easypaisa", sortOrder: 3, active: true }
];
