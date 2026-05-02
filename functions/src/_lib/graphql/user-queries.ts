export const GET_RESTAURANT_USER_BY_ID = `
  query GetRestaurantUserById($id: uuid!) {
    restaurant_users_by_pk(id: $id) {
      id username email display_name profile_image about_me palates
      language_preference onboarding_complete created_at updated_at deleted_at
    }
  }
`;

export const GET_RESTAURANT_USERS_BY_IDS = `
  query GetRestaurantUsersByIds($ids: [uuid!]!, $limit: Int = 100) {
    restaurant_users(where: { id: { _in: $ids }, deleted_at: { _is_null: true } }, limit: $limit) {
      id username display_name profile_image palates
    }
  }
`;

export const SOFT_DELETE_RESTAURANT_USER = `
  mutation SoftDeleteRestaurantUser($id: uuid!) {
    update_restaurant_users_by_pk(pk_columns: { id: $id }, _set: { deleted_at: "now()" }) {
      id deleted_at
    }
  }
`;

export const DELETE_RESTAURANT_USER = `
  mutation DeleteRestaurantUser($id: uuid!) {
    delete_restaurant_users_by_pk(id: $id) { id username }
  }
`;

export const GET_FOLLOWING_LIST = `
  query GetFollowingList($userId: uuid!, $limit: Int, $offset: Int) {
    restaurant_user_follows(
      where: { follower_id: { _eq: $userId } }
      limit: $limit offset: $offset order_by: { created_at: desc }
    ) { id created_at follower_id user_id }
    restaurant_user_follows_aggregate(where: { follower_id: { _eq: $userId } }) {
      aggregate { count }
    }
  }
`;

export const CHECK_FOLLOW_STATUS = `
  query CheckFollowStatus($followerId: uuid!, $userId: uuid!) {
    restaurant_user_follows(
      where: { follower_id: { _eq: $followerId }, user_id: { _eq: $userId } }
      limit: 1
    ) { id }
  }
`;

export const GET_FOLLOWERS_COUNT = `
  query GetFollowersCount($userId: uuid!) {
    restaurant_user_follows_aggregate(where: { user_id: { _eq: $userId } }) {
      aggregate { count }
    }
  }
`;

export const GET_FOLLOWING_COUNT = `
  query GetFollowingCount($userId: uuid!) {
    restaurant_user_follows_aggregate(where: { follower_id: { _eq: $userId } }) {
      aggregate { count }
    }
  }
`;

export const FOLLOW_USER = `
  mutation FollowUser($followerId: uuid!, $userId: uuid!) {
    insert_restaurant_user_follows_one(object: { follower_id: $followerId, user_id: $userId }) {
      id follower_id user_id created_at
    }
  }
`;

export const UNFOLLOW_USER = `
  mutation UnfollowUser($followerId: uuid!, $userId: uuid!) {
    delete_restaurant_user_follows(
      where: { follower_id: { _eq: $followerId }, user_id: { _eq: $userId } }
    ) { affected_rows returning { id } }
  }
`;
