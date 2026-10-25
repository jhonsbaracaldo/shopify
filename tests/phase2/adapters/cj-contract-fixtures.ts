/**
 * FIXTURES DE CONTRATO — CJdropshipping API 2.0
 *
 * Construidas a mano a partir de los nombres de campo y formatos de la documentación oficial
 * (https://developers.cjdropshipping.com/en/api/api2/, consultada el 2026-10-18).
 * NO son respuestas reales capturadas de CJ: los IDs, SKU, precios e inventarios son ficticios.
 * Su propósito es verificar que el adaptador traduce correctamente ese contrato y tolera
 * variaciones documentadas (números como string, rangos de precio, campos ausentes).
 */

export const CJ_TOKEN_RESPONSE = {
  code: 200,
  result: true,
  message: 'Success',
  data: {
    openId: 123456789,
    accessToken: 'TOKEN-FICTICIO-DE-PRUEBA',
    accessTokenExpiryDate: '2026-11-02T12:00:00+08:00',
    refreshToken: 'REFRESH-FICTICIO',
    refreshTokenExpiryDate: '2027-04-16T12:00:00+08:00',
    createDate: '2026-10-18T12:00:00+08:00',
  },
  requestId: 'req-token-1',
};

export const CJ_LIST_V2_RESPONSE = {
  code: 200,
  result: true,
  message: 'Success',
  data: {
    pageSize: 2,
    pageNumber: 1,
    totalRecords: 3,
    totalPages: 2,
    content: [
      {
        productList: [
          {
            id: 'PID-FICT-1',
            nameEn: 'Fictional Laptop Stand',
            sku: 'CJFICT001',
            bigImage: 'https://example.com/cj/1.jpg',
            sellPrice: '9.80',
            threeCategoryName: 'Laptop Stands',
            warehouseInventoryNum: 120,
          },
          {
            id: 'PID-FICT-2',
            nameEn: 'Fictional Bottle',
            sku: 'CJFICT002',
            bigImage: 'https://example.com/cj/2.jpg',
            sellPrice: '3.29 -- 5.12',
            threeCategoryName: 'Drinkware',
          },
          { nameEn: 'Item sin id (debe omitirse)' },
        ],
      },
    ],
  },
  requestId: 'req-list-1',
};

export const CJ_PRODUCT_QUERY_RESPONSE = {
  code: 200,
  result: true,
  message: 'Success',
  data: {
    pid: 'PID-FICT-1',
    productNameEn: 'Fictional Laptop Stand',
    productSku: 'CJFICT001',
    bigImage: 'https://example.com/cj/1.jpg',
    productImageSet: '["https://example.com/cj/1.jpg","https://example.com/cj/1b.jpg"]',
    description: '<p>Aluminum stand</p>',
    categoryName: 'Laptop Stands',
    productKeyEn: 'Color-Size',
    sellPrice: 9.8,
    variants: [
      {
        vid: 'VID-FICT-1A',
        pid: 'PID-FICT-1',
        variantSku: 'CJFICT001-Silver-L',
        variantNameEn: 'Silver L',
        variantKey: 'Silver-L',
        variantImage: 'https://example.com/cj/1a.jpg',
        variantWeight: 650,
        variantSellPrice: 9.8,
        variantSugSellPrice: 34.99,
        inventories: [
          {
            countryCode: 'US',
            totalInventory: 340,
            cjInventory: 300,
            factoryInventory: 40,
            verifiedWarehouse: 1,
          },
          {
            countryCode: 'CN',
            totalInventory: 5000,
            cjInventory: 5000,
            factoryInventory: 0,
            verifiedWarehouse: 1,
          },
        ],
      },
      {
        // Variante sin inventario en el detalle: el adaptador debe consultar /product/stock/queryByVid.
        vid: 'VID-FICT-1B',
        pid: 'PID-FICT-1',
        variantSku: 'CJFICT001-Gray-L',
        variantKey: 'Gray-L',
        variantWeight: '660',
        variantSellPrice: '10.10',
      },
    ],
  },
  requestId: 'req-query-1',
};

export const CJ_STOCK_BY_VID_RESPONSE = {
  code: 200,
  result: true,
  message: 'Success',
  data: [
    {
      vid: 'VID-FICT-1B',
      areaId: 2,
      areaEn: 'US Warehouse',
      countryCode: 'US',
      totalInventoryNum: 75,
      cjInventoryNum: 75,
      factoryInventoryNum: 0,
    },
  ],
  requestId: 'req-stock-1',
};

export const CJ_FREIGHT_RESPONSE = {
  code: 200,
  result: true,
  message: 'Success',
  data: [
    { logisticName: 'Fictional US Ground', logisticAging: '2-5', logisticPrice: 4.95 },
    { logisticName: 'Fictional US Express', logisticAging: '1-2', logisticPrice: '12.40' },
    { logisticName: 'Sin precio (debe omitirse)', logisticAging: '3-6' },
  ],
  requestId: 'req-freight-1',
};

export const CJ_RATE_LIMIT_RESPONSE = {
  code: 1600200,
  result: false,
  message: 'Too many requests',
  data: null,
  requestId: 'req-rl',
};
export const CJ_INVALID_TOKEN_RESPONSE = {
  code: 1600001,
  result: false,
  message: 'Invalid token',
  data: null,
  requestId: 'req-auth',
};
export const CJ_GENERIC_ERROR_RESPONSE = {
  code: 1603000,
  result: false,
  message: 'Product not exist',
  data: null,
  requestId: 'req-err',
};
