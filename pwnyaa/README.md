# pwnyaa - Pwnable Devotion Bot  

## About  
Praise you pwning everyday.  

## Implementation
### Info to save
- Contests
  - name
  - joining users info

### Info to fetch per contest
- challs
  - name
  - score
  - id
- solved information of joining users
  - id
  - solved date


### Note
- The way of fetching data is different contest by contest.  Therefore, I save only name and joining users list for a contest. Fetching should be separately.
  - Contest info is used only for displaying daily information, not for fetching.


### Functionalities
- Daily Devotion
  - Show daily information.
    - Daily information consists of
      - Ranking of the num of newly solved challs.
      - Total solves
  - can be invoked by pre-defined keyword in slack.
- Join a contest
