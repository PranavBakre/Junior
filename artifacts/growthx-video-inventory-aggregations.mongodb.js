// GrowthX video inventory review queries.
// Run in mongosh after selecting `gx-prod-database`.
// Local review artifact only; do not treat cached `products.duration` as authoritative.
//
// Snapshot from 2026-08-21 (unique module IDs, type=video):
//   Crafts: 184 videos, 80,885.044s
//   Deep dives/resources: 155 videos, 684,638.48s
//   Other member-only: 162 videos, 138,646.26313s
//   GLX: 5 extant videos, 8,033s (product has 6 refs; one is dangling)
//   AGS: 47 videos, 75,075s
//   Total: 553 duration-bearing videos, 987,277.78713s (274h 14m 38s)
// Eight missing durations were recovered from authenticated browser playback
// metadata. Three additional video records have no source URL or Mux asset and
// remain excluded from hours. Inactive/unset records remain in stored inventory.
//
// Universe audit additions:
//   4 current-product MP4 lessons are mistyped as `module`/`text`: 3,718s.
//   Corrected course inventory including those: 557 videos, 990,995.78713s
//   (275h 16m 36s).
//   14 legacy concept videos have no ancestry/product reference: 5,790s.
//   Keep these as unassigned archive, not inside a requested category.
//   11 product-level video_url records are trailers/previews, not lessons.
//   10 public trailers resolve to 1,229.561149s; the private GLX trailer is
//   unresolved. Keep trailers separate from course inventory.

const products = db.getCollection("products");
const modules = db.getCollection("modules");

// Browser-recovered durations are a reporting overlay only. Production remains
// read-only; these values are not written back by this artifact.
const browserRecoveredDurations = new Map([
  ["6960e0660a04c67ceec1e8e6", 3879.72],
  ["66cf68271cd42a8bf63dd8ca", 845.044],
  ["675f5d74f683f304f86cc86b", 6013.24],
  ["696147fb0a04c67ceec3f2b6", 4362.88],
  ["675a8a9dbed37f4a42a6f5fb", 6177.8],
  ["6720e85b597301042cd51f35", 138.26313],
  ["675b3a50fd8a2c2d57f72a56", 5382.12],
  ["675b31ed439b9ccfd5bb9538", 5059.72],
]);

// 1. GLX source-of-truth check.
// GLX is the Limited Experience product (`type: GLX`), not every `LX` product.
const glx = products.findOne(
  { type: "GLX" },
  { name: 1, active: 1, modules: 1 },
);

const glxModules = modules
  .find(
    { _id: { $in: glx.modules } },
    { moduleId: 1, name: 1, type: 1, duration: 1, active: 1 },
  )
  .toArray();

printjson({
  product: glx.name,
  referencedModules: glx.modules.length,
  existingModules: glxModules.length,
  danglingModuleIds: glx.modules.filter(
    (id) => !glxModules.some((module) => module._id.equals(id)),
  ),
  durationSeconds: glxModules.reduce(
    (total, module) => total + (module.duration || 0),
    0,
  ),
  modules: glxModules,
});

// 2. Module-first inventory grouped by the actual business categories.
// Only leaf video records are counted. A module reused by multiple products is
// grouped once by module _id, with all matching categories retained for review.
const categoryExpression = {
  $switch: {
    branches: [
      { case: { $eq: ["$product.type", "GLX"] }, then: "GLX" },
      {
        case: {
          $and: [
            { $eq: ["$product.type", "LX"] },
            { $eq: ["$product.name", "Advanced Growth Strategy"] },
          ],
        },
        then: "AGS",
      },
      { case: { $eq: ["$product.type", "LX"] }, then: "Crafts" },
      {
        case: { $eq: ["$product.type", "RESOURCE_DIRECTORY"] },
        then: "Deep dives (resources)",
      },
      {
        case: {
          $and: [
            { $eq: ["$product.requires_subscription", true] },
            { $in: ["$product.type", ["FOUNDATIONS", "TALENT"]] },
          ],
        },
        then: "Other member-only videos",
      },
    ],
    default: null,
  },
};

const moduleFirstInventory = modules.aggregate([
  { $match: { type: "video", duration: { $gt: 0 } } },
  {
    $project: {
      moduleId: 1,
      name: 1,
      duration: 1,
      active: 1,
      productIds: {
        $map: {
          input: { $objectToArray: { $ifNull: ["$ancestry", {}] } },
          as: "ancestor",
          in: {
            $convert: {
              input: "$$ancestor.k",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
    },
  },
  { $unwind: "$productIds" },
  { $match: { productIds: { $ne: null } } },
  {
    $lookup: {
      from: "products",
      localField: "productIds",
      foreignField: "_id",
      as: "product",
    },
  },
  { $unwind: "$product" },
  {
    $match: {
      $or: [{ "product.active": true }, { "product.type": "GLX" }],
    },
  },
  {
    $project: {
      moduleId: 1,
      name: 1,
      duration: 1,
      active: 1,
      productName: "$product.name",
      category: categoryExpression,
    },
  },
  { $match: { category: { $ne: null } } },
  {
    $group: {
      _id: "$_id",
      moduleId: { $first: "$moduleId" },
      name: { $first: "$name" },
      duration: { $first: "$duration" },
      active: { $first: "$active" },
      categories: { $addToSet: "$category" },
      products: { $addToSet: "$productName" },
    },
  },
  {
    $group: {
      _id: "$categories",
      uniqueVideos: { $sum: 1 },
      durationSeconds: { $sum: "$duration" },
      videos: {
        $push: {
          _id: "$_id",
          moduleId: "$moduleId",
          name: "$name",
          duration: "$duration",
          active: "$active",
          products: "$products",
        },
      },
    },
  },
  { $sort: { durationSeconds: -1 } },
]);

moduleFirstInventory.forEach(printjson);

// 3. Explicitly inspect cross-category reuse before assigning a shared video
// to one reporting bucket. This prevents category totals from exceeding the
// unique grand total.
modules
  .aggregate([
    { $match: { type: "video", duration: { $gt: 0 } } },
    {
      $project: {
        moduleId: 1,
        name: 1,
        duration: 1,
        productIds: {
          $map: {
            input: { $objectToArray: { $ifNull: ["$ancestry", {}] } },
            as: "ancestor",
            in: {
              $convert: {
                input: "$$ancestor.k",
                to: "objectId",
                onError: null,
                onNull: null,
              },
            },
          },
        },
      },
    },
    { $unwind: "$productIds" },
    {
      $lookup: {
        from: "products",
        localField: "productIds",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: "$product" },
    {
      $match: {
        $or: [{ "product.active": true }, { "product.type": "GLX" }],
      },
    },
    {
      $project: {
        moduleId: 1,
        name: 1,
        duration: 1,
        productName: "$product.name",
        category: categoryExpression,
      },
    },
    { $match: { category: { $ne: null } } },
    {
      $group: {
        _id: "$_id",
        moduleId: { $first: "$moduleId" },
        name: { $first: "$name" },
        duration: { $first: "$duration" },
        categories: { $addToSet: "$category" },
        products: { $addToSet: "$productName" },
      },
    },
    { $match: { "categories.1": { $exists: true } } },
    { $sort: { name: 1 } },
  ])
  .forEach(printjson);

// 4. Compatibility audit: MP4 lessons whose legacy type is not `video`.
modules
  .aggregate([
    {
      $match: {
        type: { $ne: "video" },
        "content_url.original": { $regex: /\.mp4(?:\?|$)/i },
      },
    },
    {
      $project: {
        moduleId: 1,
        name: 1,
        type: 1,
        duration: 1,
        active: 1,
        ancestry: 1,
        originalUrl: "$content_url.original",
      },
    },
    { $sort: { name: 1 } },
  ])
  .forEach(printjson);

// 5. Orphan/archive audit: video records not attached through ancestry.
modules
  .find(
    {
      type: "video",
      $or: [{ ancestry: { $exists: false } }, { ancestry: {} }],
    },
    {
      moduleId: 1,
      name: 1,
      duration: 1,
      active: 1,
      content_url: 1,
    },
  )
  .sort({ name: 1 })
  .forEach(printjson);

// 6. Product trailers/previews: real videos stored outside modules.
products
  .find(
    { video_url: { $exists: true, $nin: [null, ""] } },
    { name: 1, type: 1, active: 1, video_url: 1 },
  )
  .sort({ type: 1, name: 1 })
  .forEach(printjson);
