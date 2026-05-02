export const GET_REVIEW_BY_ID = `
  query GetReviewById($id: uuid!) {
    restaurant_reviews_by_pk(id: $id) {
      id restaurant_uuid author_id parent_review_id title content rating
      images palates hashtags mentions recognitions likes_count replies_count
      status is_pinned is_featured created_at updated_at published_at deleted_at
    }
  }
`;

export const CREATE_REVIEW = `
  mutation CreateReview($object: restaurant_reviews_insert_input!) {
    insert_restaurant_reviews_one(object: $object) {
      id title content rating status created_at restaurant_uuid author_id
    }
  }
`;

export const UPDATE_REVIEW = `
  mutation UpdateReview($id: uuid!, $changes: restaurant_reviews_set_input!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id }, _set: $changes) {
      id restaurant_uuid title content rating images palates hashtags status updated_at
    }
  }
`;

export const DELETE_REVIEW = `
  mutation DeleteReview($id: uuid!) {
    update_restaurant_reviews_by_pk(
      pk_columns: { id: $id }
      _set: { deleted_at: "now()" }
    ) { id restaurant_uuid parent_review_id deleted_at }
  }
`;

export const INCREMENT_REPLIES_COUNT = `
  mutation IncrementRepliesCount($id: uuid!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id }, _inc: { replies_count: 1 }) {
      id replies_count
    }
  }
`;

export const DECREMENT_REPLIES_COUNT = `
  mutation DecrementRepliesCount($id: uuid!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id }, _inc: { replies_count: -1 }) {
      id replies_count
    }
  }
`;

export const GET_REVIEWS_BY_AUTHORS = `
  query GetReviewsByAuthors($authorIds: [uuid!]!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: {
        author_id: { _in: $authorIds }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id title content rating images palates hashtags mentions recognitions
      likes_count replies_count status created_at published_at author_id restaurant_uuid
    }
    restaurant_reviews_aggregate(
      where: {
        author_id: { _in: $authorIds }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
    ) { aggregate { count } }
  }
`;

export const GET_REVIEWS_BY_AUTHORS_CURSOR = `
  query GetReviewsByAuthorsCursor($authorIds: [uuid!]!, $limit: Int!, $cursorCreatedAt: timestamptz!, $cursorId: uuid!) {
    restaurant_reviews(
      where: {
        _and: [
          { author_id: { _in: $authorIds } }
          { deleted_at: { _is_null: true } }
          { parent_review_id: { _is_null: true } }
          { status: { _eq: "approved" } }
          { _or: [
            { created_at: { _lt: $cursorCreatedAt } }
            { _and: [{ created_at: { _eq: $cursorCreatedAt } }, { id: { _lt: $cursorId } }] }
          ]}
        ]
      }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit
    ) {
      id title content rating images palates hashtags mentions recognitions
      likes_count replies_count status created_at published_at author_id restaurant_uuid
    }
  }
`;
