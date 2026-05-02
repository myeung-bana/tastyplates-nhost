export const GET_RESTAURANTS_LIST = `
  query GetRestaurantsList($where: restaurants_bool_exp, $limit: Int!, $offset: Int!, $order_by: [restaurants_order_by!]) {
    restaurants(where: $where, limit: $limit, offset: $offset, order_by: $order_by) {
      id uuid title slug status listing_street featured_image_url
      average_rating ratings_count latitude longitude address
      cuisines palates categories price_range_id is_main_location created_at updated_at
    }
    restaurants_aggregate(where: $where) { aggregate { count } }
  }
`;

export const GET_RESTAURANTS_BY_UUIDS = `
  query GetRestaurantsByUuids($uuids: [uuid!]!, $limit: Int = 100) {
    restaurants(where: { uuid: { _in: $uuids } }, limit: $limit) {
      uuid id title slug featured_image_url
    }
  }
`;

export const MATCH_RESTAURANT_BY_PLACE_ID = `
  query MatchRestaurantByPlaceId($placeId: String!) {
    restaurants(where: { place_id: { _eq: $placeId } }, limit: 1) {
      id uuid title slug status listing_street phone menu_url
      longitude latitude featured_image_url average_rating ratings_count address
    }
  }
`;

export const MATCH_RESTAURANT_BY_NAME_ADDRESS = `
  query MatchRestaurantByNameAddress($name: String!, $address: String!) {
    restaurants(
      where: {
        _and: [
          { title: { _ilike: $name } }
          { listing_street: { _ilike: $address } }
        ]
      }
      limit: 1
    ) {
      id uuid title slug status listing_street phone menu_url
      longitude latitude featured_image_url average_rating ratings_count address
    }
  }
`;

export const GET_SMART_SORT_SUMMARIES = `
  query SmartSortSummaries {
    restaurant_rating_summary(
      order_by: [{ authentic_rating_weighted: desc_nulls_last }, { restaurant_id: desc }]
    ) { restaurant_id authentic_rating_weighted }
  }
`;

export const GET_ALL_RESTAURANT_UUIDS_PAGINATED = `
  query BackfillGetRestaurants($limit: Int!, $offset: Int!) {
    restaurants(where: { status: { _eq: "publish" } }, order_by: { id: asc }, limit: $limit, offset: $offset) {
      uuid title
    }
    restaurants_aggregate(where: { status: { _eq: "publish" } }) { aggregate { count } }
  }
`;
